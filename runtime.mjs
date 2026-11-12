import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ModelStore } from './model-store.mjs';
import { managedConfig, tomlValue } from './model-config.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ACTIVE = new Set(['running', 'cancelling']);
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const now = () => new Date().toISOString();

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function redact(text) {
  return String(text)
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1<REDACTED>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<REDACTED>')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'\]}]+/gi, '$1<REDACTED>');
}

export function resolveCodexBinary(env = process.env) {
  if (env.CODEX_SUBAGENT_CODEX_BIN) return env.CODEX_SUBAGENT_CODEX_BIN;
  if (process.platform === 'win32') {
    const binRoot = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const bins = readdirSync(binRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(binRoot, entry.name, 'codex.exe'))
        .filter(path => existsSync(path))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (bins.length) return bins[0];
    } catch {}
  }
  return 'codex';
}

// Only bounded metadata is retained from the event stream, never tool output or reasoning.
export function consumeJsonLines(stream, onEvent, onOversized = () => {}) {
  stream.setEncoding('utf8');
  let pending = '';
  let skipping = false;
  const deliver = () => {
    if (!skipping && pending.trim()) {
      try { onEvent(JSON.parse(pending)); } catch {}
    }
    pending = '';
    skipping = false;
  };
  stream.on('data', chunk => {
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (!skipping) {
        if (pending.length + parts[i].length > 2_000_000) {
          pending = '';
          skipping = true;
          onOversized();
        } else pending += parts[i];
      }
      if (i < parts.length - 1) deliver();
    }
  });
  stream.on('end', deliver);
}

async function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolveKill, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      killer.on('error', reject);
      killer.on('exit', code => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolveKill();
        else reject(new Error(`taskkill exited with code ${code}`));
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export class JobManager {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.codexBin = options.codexBin || resolveCodexBinary(this.env);
    this.codexArgs = options.codexArgs || [];
    this.defaultProfile = this.env.CODEX_SUBAGENT_PROFILE || 'workbuddy';
    this.defaultModel = this.env.CODEX_SUBAGENT_MODEL || 'deepseek-v4.1-flash';
    this.depth = Number(this.env.CODEX_SUBAGENT_DEPTH || 0);
    this.maxDepth = Number(this.env.CODEX_SUBAGENT_MAX_DEPTH || 2);
    this.maxConcurrent = integer(Number(this.env.CODEX_SUBAGENT_MAX_CONCURRENT || 2), 2, 1, 16, 'max concurrency');
    this.defaultOutputChars = integer(Number(this.env.CODEX_SUBAGENT_MAX_OUTPUT_CHARS || 4000), 4000, 256, 16000, 'output limit');
    this.stateDir = resolve(options.stateDir || this.env.CODEX_SUBAGENT_STATE_DIR || join(dirname(fileURLToPath(import.meta.url)), 'state'));
    mkdirSync(join(this.stateDir, 'jobs'), { recursive: true });
    mkdirSync(join(this.stateDir, 'sessions'), { recursive: true });
    this.modelStore = options.modelStore || new ModelStore({ stateDir: this.stateDir, env: this.env });
    this.instance = randomUUID();
    this.jobs = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);
    this.closing = false;
  }

  jobDir(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('job_id must be a UUID returned by this tool');
    return join(this.stateDir, 'jobs', id);
  }

  persist(job) {
    const path = join(this.jobDir(job.job_id), 'job.json');
    const temp = `${path}.${this.instance}.tmp`;
    writeFileSync(temp, JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  }

  load(id) {
    const local = this.jobs.get(id);
    if (local) return local.job;
    let job;
    try { job = JSON.parse(readFileSync(join(this.jobDir(id), 'job.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Unknown job: ${id}`);
      throw error;
    }
    if (job.job_id !== id) throw new Error('Invalid stored job');
    if (ACTIVE.has(job.status) && !alive(job.owner_pid)) {
      job.status = 'interrupted';
      job.finished_at = now();
      job.error = 'The owning MCP process exited before this task completed. Resume the recorded session if available.';
      if (job.usage.status === 'pending') job.usage = { status: 'unavailable', reason: 'no_usage_reported' };
      this.persist(job);
    }
    return job;
  }

  lockSession(sessionId, jobId) {
    if (!UUID.test(sessionId)) throw new Error('Invalid session ID from Codex');
    const path = join(this.stateDir, 'sessions', `${sessionId}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ job_id: jobId, owner_pid: process.pid, instance: this.instance }), { flag: 'wx', mode: 0o600 });
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const holder = JSON.parse(readFileSync(path, 'utf8'));
        if (alive(holder.owner_pid)) throw new Error(`Session already has an active task: ${holder.job_id}`);
        unlinkSync(path);
      }
    }
    throw new Error('Could not acquire the session lock; try again');
  }

  unlockSession(job) {
    if (!job.session_id) return;
    const path = join(this.stateDir, 'sessions', `${job.session_id}.lock`);
    try {
      const holder = JSON.parse(readFileSync(path, 'utf8'));
      if (holder.job_id === job.job_id && holder.instance === this.instance) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`Session lock cleanup: ${redact(error.message)}\n`); }
  }

  start(args = {}, parent = null) {
    if (this.closing) throw new Error('MCP server is shutting down');
    if (!Number.isFinite(this.depth) || !Number.isFinite(this.maxDepth) || this.depth >= this.maxDepth) {
      throw new Error('Subagent nesting limit reached; perform this task in the caller');
    }
    if ([...this.jobs.values()].filter(record => ACTIVE.has(record.job.status)).length >= this.maxConcurrent) {
      throw new Error(`Concurrency limit (${this.maxConcurrent}) reached; wait for or cancel an existing task`);
    }
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 200_000) {
      throw new Error('prompt must be a nonempty string of at most 200000 characters');
    }
    const cwd = parent?.cwd || args.cwd || process.cwd();
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error('cwd must be an existing absolute directory; it will not silently fall back');
    }
    const selected = this.modelStore.select(args, parent);
    const model = selected.model;
    const profile = selected.profile;
    const connection = selected.connection;
    if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Invalid model');
    if (profile !== null && (typeof profile !== 'string' || !/^[A-Za-z0-9_-]+$/.test(profile))) throw new Error('Invalid profile name');
    const sandbox = parent?.sandbox || args.sandbox || 'workspace-write';
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new Error('Invalid sandbox');
    const timeoutSec = integer(args.timeout_sec, 900, 1, 86400, 'timeout_sec');
    const outputChars = integer(args.max_output_chars, this.defaultOutputChars, 256, 16000, 'max_output_chars');
    if (parent && ACTIVE.has(parent.status)) throw new Error('The previous task is still running; wait for it or cancel it first');
    if (parent && !parent.session_id) throw new Error('This job has no recorded Codex session to resume');
    for (const key of ['cwd', 'model', 'profile', 'sandbox', 'connection_id']) {
      if (parent && args[key] !== undefined && args[key] !== parent[key]) throw new Error(`resume keeps the original ${key}; start a new job to change it`);
    }
    const managed = connection && connection.kind !== 'profile';
    const gatewayPort = managed ? Number(this.env.CODEX_SUBAGENT_VIEWER_PORT || 43187) : null;
    if (managed && (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)) throw new Error('Invalid local gateway port');
    const gatewayToken = managed ? this.modelStore.gatewayToken() : null;
    const job = {
      job_id: randomUUID(), status: 'running', session_id: parent?.session_id || null,
      parent_job_id: parent?.job_id || null, model, profile, sandbox, cwd,
      ...(connection ? { connection_id: connection.id, connection_name: connection.name, connection_fingerprint: this.modelStore.fingerprint(connection) } : {}),
      title: args.prompt.trim().split('\n')[0].slice(0, 90),
      owner_pid: process.pid, owner_instance: this.instance, child_pid: null,
      started_at: now(), finished_at: null, timeout_sec: timeoutSec, max_output_chars: outputChars,
      progress: { event_count: 0, last_event: 'starting', last_item_type: null },
      usage: { status: 'pending' }, result_chars: 0, exit_code: null, error: null,
    };
    const record = { job, child: null, stopping: null, finalMessage: '', stderr: '', timer: null, saveTimer: null, spawnError: null };
    if (parent) this.lockSession(job.session_id, job.job_id);
    try {
      mkdirSync(this.jobDir(job.job_id), { recursive: true });
      appendFileSync(join(this.jobDir(job.job_id), 'history.jsonl'), JSON.stringify({ kind: 'user', at: job.started_at, text: args.prompt }) + '\n', { mode: 0o600 });
      this.persist(job);
      this.jobs.set(job.job_id, record);
    } catch (error) {
      this.unlockSession(job);
      throw error;
    }
    const resultPath = join(this.jobDir(job.job_id), 'result.txt');
    const argv = [
      ...this.codexArgs, 'exec', ...(profile ? ['--profile', profile] : []), '--model', model, '--cd', cwd,
      '--sandbox', sandbox, '--skip-git-repo-check', '--json', '--color', 'never',
      '--output-last-message', resultPath, '-c', 'mcp_servers.codex-subagent.enabled=false',
    ];
    const childEnv = { ...this.env, CODEX_SUBAGENT_DEPTH: String(this.depth + 1) };
    if (managed) {
      const overrides = managedConfig(connection, { baseUrl: `http://127.0.0.1:${gatewayPort}`, fingerprint: job.connection_fingerprint, model });
      for (const [key, value] of Object.entries(overrides)) argv.push('-c', `${key}=${tomlValue(value)}`);
      childEnv.SUBAGENT_GATEWAY_TOKEN = gatewayToken;
    }
    if (parent) argv.push('resume', job.session_id);
    argv.push('-');
    const instructions = 'Complete the task below. Keep the final reply concise; include changed files, verification, and unresolved issues when relevant. Save long artifacts to files instead of echoing full files or logs. Explicit task output requirements take precedence.\n\nTask:\n';
    try {
      const child = spawn(this.codexBin, argv, {
        cwd, env: childEnv,
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      record.child = child;
      job.child_pid = child.pid || null;
      this.persist(job);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') record.spawnError = error.message; });
      child.stdin.end(instructions + args.prompt, 'utf8');
      consumeJsonLines(child.stdout, event => this.onEvent(record, event), () => {
        job.progress.oversized_events = (job.progress.oversized_events || 0) + 1;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk).slice(-8192); });
      child.on('error', error => { record.spawnError = error.message; });
      child.on('close', (code, signal) => this.finish(record, code, signal));
      record.timer = setTimeout(() => this.requestStop(job.job_id, 'timed_out'), timeoutSec * 1000);
    } catch (error) {
      record.spawnError = error.message;
      this.finish(record, null, null);
    }
    return job.job_id;
  }

  onEvent(record, event) {
    const { job } = record;
    if (/^item\.(started|updated|completed)$/.test(event.type) && ['agent_message', 'command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)) {
      appendFileSync(join(this.jobDir(job.job_id), 'history.jsonl'), JSON.stringify({ at: now(), type: event.type, item: event.item }) + '\n', { mode: 0o600 });
    }
    job.progress.event_count++;
    const type = typeof event.type === 'string' ? event.type.slice(0, 80) : 'unknown';
    job.progress.last_event = type;
    if (event.item?.type) job.progress.last_item_type = String(event.item.type).slice(0, 80);
    if (type === 'item.completed') {
      if (event.item?.type === 'command_execution') job.progress.completed_commands = (job.progress.completed_commands || 0) + 1;
      if (event.item?.type === 'mcp_tool_call') job.progress.completed_mcp_calls = (job.progress.completed_mcp_calls || 0) + 1;
      if (event.item?.type === 'file_change') job.progress.changed_files = (job.progress.changed_files || 0) + (event.item.changes?.length || 0);
    }
    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      if (job.session_id && job.session_id !== event.thread_id) {
        job.error = 'Codex resumed a different session than requested';
        this.requestStop(job.job_id, 'failed');
      } else if (!job.session_id) {
        try {
          this.lockSession(event.thread_id, job.job_id);
          job.session_id = event.thread_id;
        } catch (error) {
          job.error = redact(error.message);
          this.requestStop(job.job_id, 'failed');
        }
      }
    }
    if (type === 'item.completed' && event.item?.type === 'agent_message') {
      record.finalMessage = typeof event.item.text === 'string' ? event.item.text : '';
    }
    if (type === 'turn.completed' && event.usage) {
      const values = {};
      for (const key of USAGE_KEYS) {
        const value = event.usage[key];
        if (Number.isFinite(value) && value >= 0) values[key] = value;
      }
      if (Object.values(values).some(value => value > 0)) {
        const prior = job.usage.status === 'reported' ? job.usage : {};
        job.usage = { status: 'reported' };
        for (const key of USAGE_KEYS) if (key in values || key in prior) job.usage[key] = (prior[key] || 0) + (values[key] || 0);
      } else if (job.usage.status !== 'reported') {
        job.usage = { status: 'unavailable', reason: 'provider_returned_zero_or_missing_usage' };
      }
    }
    if (type === 'turn.failed' || type === 'error') {
      const detail = event.error?.message || event.message;
      if (detail) job.error = redact(detail).slice(0, 1200);
      if (type === 'turn.failed') record.turnFailed = true;
    }
    if (!record.saveTimer) record.saveTimer = setTimeout(() => {
      record.saveTimer = null;
      this.persist(job);
    }, 500);
  }

  finish(record, code, signal) {
    const { job } = record;
    if (!ACTIVE.has(job.status)) return;
    clearTimeout(record.timer);
    clearTimeout(record.saveTimer);
    const resultPath = join(this.jobDir(job.job_id), 'result.txt');
    let final = record.finalMessage;
    try { final = readFileSync(resultPath, 'utf8'); } catch {}
    writeFileSync(resultPath, final, { encoding: 'utf8', mode: 0o600 });
    job.result_chars = final.length;
    job.exit_code = code;
    job.finished_at = now();
    job.status = record.stopping || (code === 0 && !record.turnFailed && final.trim() ? 'completed' : 'failed');
    if (job.status === 'failed' && !job.error) {
      job.error = redact(record.spawnError || record.stderr.trim().slice(-1200) || `Codex exited ${code ?? signal ?? 'without a final reply'}`).slice(0, 1200);
    }
    if (job.status === 'timed_out') job.error = `Task exceeded ${job.timeout_sec} seconds; the child process was terminated`;
    if (job.status === 'interrupted') job.error = 'MCP connection closed; resume this session to continue';
    if (job.usage.status === 'pending') job.usage = { status: 'unavailable', reason: 'no_usage_reported' };
    this.unlockSession(job);
    this.persist(job);
    record.stderr = '';
    record.finalMessage = '';
    record.child = null;
    this.jobs.delete(job.job_id);
    this.events.emit(job.job_id);
  }

  async stop(id, reason = 'cancelled') {
    const record = this.jobs.get(id);
    const job = this.load(id);
    if (!ACTIVE.has(job.status)) return this.view(id);
    if (!record) throw new Error('This active job belongs to another live MCP connection; cancel it from the originating chat');
    if (!record.stopping) {
      record.stopping = reason;
      job.status = 'cancelling';
      this.persist(job);
      try { await killTree(record.child); }
      catch (error) {
        job.error = `Could not terminate the process tree: ${redact(error.message)}`;
        if (this.jobs.get(id) === record && ACTIVE.has(job.status)) {
          // Keep cancellation retryable, and do not claim the process stopped.
          record.stopping = null;
          job.status = 'running';
          this.persist(job);
        }
        throw new Error(job.error);
      }
    }
    return this.wait(id, 5, false);
  }

  requestStop(id, reason) {
    void this.stop(id, reason).catch(error => {
      process.stderr.write(`${redact(error.message)}\n`);
      const record = this.jobs.get(id);
      if (reason === 'timed_out' && record && !this.closing) {
        record.timer = setTimeout(() => this.requestStop(id, reason), 5000);
      }
    });
  }

  async wait(id, seconds = 25, includeResult = true) {
    integer(seconds, 25, 0, 30, 'wait_sec');
    const deadline = Date.now() + seconds * 1000;
    while (ACTIVE.has(this.load(id).status) && Date.now() < deadline) {
      await new Promise(resolveWait => {
        const done = () => { clearTimeout(timer); this.events.off(id, done); resolveWait(); };
        const timer = setTimeout(done, Math.min(1000, deadline - Date.now()));
        this.events.once(id, done);
      });
    }
    const job = this.load(id);
    return this.view(id, includeResult && !ACTIVE.has(job.status));
  }

  view(id, includeResult = false, args = {}) {
    const job = this.load(id);
    const summary = {
      job_id: job.job_id, status: job.status, session_id: job.session_id,
      model: job.model, profile: job.profile,
      ...(job.connection_id ? { connection_id: job.connection_id, connection_name: job.connection_name } : {}),
      elapsed_sec: Math.round((Date.parse(job.finished_at || now()) - Date.parse(job.started_at)) / 100) / 10,
      progress: job.progress, usage: job.usage,
    };
    if (job.parent_job_id) summary.parent_job_id = job.parent_job_id;
    if (job.error) summary.error = job.error;
    if (includeResult) {
      const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
      const limit = integer(args.max_output_chars, job.max_output_chars, 256, 16000, 'max_output_chars');
      let text = '';
      try { text = readFileSync(join(this.jobDir(id), 'result.txt'), 'utf8'); } catch {}
      if (offset > text.length) throw new Error('offset is past the end of the result');
      let end = Math.min(offset + limit, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      summary.result = {
        text: text.slice(offset, end), offset, total_chars: text.length,
        truncated: end < text.length, next_offset: end < text.length ? end : null,
        path: join(this.jobDir(id), 'result.txt'),
      };
    }
    return summary;
  }

  list(limit = 10) {
    integer(limit, 10, 1, 50, 'limit');
    const jobs = [];
    for (const entry of readdirSync(join(this.stateDir, 'jobs'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const job = this.load(entry.name);
        jobs.push({ job_id: job.job_id, status: job.status, model: job.model, started_at: job.started_at });
      } catch {}
    }
    return { jobs: jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit) };
  }

  async call(args = {}) {
    const action = args.action || 'run';
    switch (action) {
      case 'run': {
        const id = this.start(args);
        while (ACTIVE.has(this.load(id).status)) await this.wait(id, 30, false);
        return this.view(id, true);
      }
      case 'start': return this.view(this.start(args));
      case 'resume': {
        const parent = this.load(args.job_id);
        return this.view(this.start(args, parent));
      }
      case 'status': return this.view(args.job_id);
      case 'wait': {
        const result = await this.wait(args.job_id, args.wait_sec);
        if (result.result && args.max_output_chars !== undefined) return this.view(args.job_id, true, args);
        return result;
      }
      case 'cancel': return this.stop(args.job_id);
      case 'result': return this.view(args.job_id, true, args);
      case 'list': return this.list(args.limit);
      case 'models': return this.modelStore.describe(args.connection_id);
      default: throw new Error(`Unknown action: ${action}`);
    }
  }

  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.jobs.values()]
      .filter(record => ACTIVE.has(record.job.status))
      .map(record => this.stop(record.job.job_id, 'interrupted')));
  }
}
