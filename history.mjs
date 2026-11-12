import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const active = new Set(['running', 'cancelling']);
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const plain = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
const metadataOf = p => ({ id: p.id, model_provider: p.model_provider, source: typeof p.source === 'string' ? p.source : 'subagent', cwd: p.cwd, timestamp: p.timestamp, model: p.model });
export const projectName = path => path.split(/[\\/]/).filter(Boolean).at(-1) || path || '未分类';

function combinedUsage(jobs = []) {
  const reported = jobs.filter(job => job.usage?.status === 'reported');
  if (!reported.length) return null;
  const usage = { status: 'reported' };
  for (const key of USAGE_KEYS) {
    const total = reported.reduce((sum, job) => sum + (Number.isFinite(job.usage[key]) ? job.usage[key] : 0), 0);
    if (total > 0 || key === 'input_tokens' || key === 'output_tokens') usage[key] = total;
  }
  if (reported.length < jobs.length) usage.partial = true;
  return usage;
}

export function cleanUserText(text) {
  text = text.trim();
  if (/^(?:<environment_context>|<permissions instructions>|<skills_instructions>|# AGENTS\.md instructions|<INSTRUCTIONS>)/i.test(text)) return '';
  const wrapper = text.indexOf('\n\nTask:\n');
  if (text.startsWith('Complete the task below.') && wrapper >= 0) text = text.slice(wrapper + 8);
  return text.trim();
}

async function* records(path) {
  const stream = createReadStream(path);
  const input = path.endsWith('.zst') ? stream.pipe(createZstdDecompress()) : stream;
  input.setEncoding('utf8');
  if (input !== stream) stream.on('error', error => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) { try { yield JSON.parse(line); } catch {} } }
  finally { lines.close(); input.destroy(); stream.destroy(); }
}

function textOf(message) {
  return (message.content || []).map(part => {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return part.text || '';
    if (/image/.test(part.type || '')) return '[图片附件]';
    return '';
  }).filter(Boolean).join('\n');
}

export async function parseRollout(path, { full = false } = {}) {
  const entries = [];
  const fallback = [];
  const calls = new Map();
  let metadata = null;
  let model = null;
  let status = 'unknown';
  let lastAt = null;
  let usage = null;
  for await (const record of records(path)) {
    const p = record.payload || {};
    const at = record.timestamp || null;
    if (at) lastAt = at;
    if (record.type === 'session_meta') metadata = metadataOf(p);
    if (record.type === 'turn_context') model = p.model || model;
    if (record.type === 'event_msg') {
      if (p.type === 'task_started' || p.type === 'turn_started') status = 'running';
      if (['task_complete', 'task_completed', 'turn_complete', 'turn_completed'].includes(p.type)) status = 'completed';
      if (['turn_aborted', 'task_aborted'].includes(p.type)) status = 'cancelled';
      if (p.type === 'user_message' && p.message) fallback.push({ kind: 'user', at, text: cleanUserText(p.message) });
      if (p.type === 'agent_message' && p.message) fallback.push({ kind: 'assistant', at, text: p.message });
      if (p.type === 'token_count' && p.info?.total_token_usage) usage = p.info.total_token_usage;
    }
    if (record.type !== 'response_item') continue;
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      let text = textOf(p);
      if (p.role === 'user') text = cleanUserText(text);
      if (text.trim()) entries.push({ kind: p.role, at, text, phase: p.phase || null });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let args;
      try { args = JSON.parse(p.arguments); } catch { args = p.arguments ?? p.input ?? ''; }
      const entry = { kind: 'tool', at, name: p.name || 'tool', call_id: p.call_id, arguments: args, output: '', status: 'running' };
      calls.set(p.call_id, entry);
      entries.push(entry);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const entry = calls.get(p.call_id);
      if (entry) {
        const output = plain(p.output);
        entry.output = full ? output : output.slice(0, 64_000);
        entry.output_truncated = !full && output.length > 64_000;
        entry.finished_at = at;
        const match = entry.output.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i);
        entry.exit_code = match ? Number(match[1]) : null;
        entry.status = entry.exit_code !== null && entry.exit_code !== 0 ? 'failed' : 'completed';
      }
    }
  }
  if (!entries.some(entry => entry.kind === 'user' || entry.kind === 'assistant')) entries.push(...fallback.filter(entry => entry.text));
  for (let i = 0; i < entries.length; i++) entries[i].id = `entry-${i}`;
  return { metadata, model, status, updated_at: lastAt, usage, entries };
}

async function inspectRollout(path, meta) {
  let firstUser = '', model = null, status = 'unknown', updatedAt = meta.timestamp;
  let turns = 0, tools = 0;
  for await (const r of records(path)) {
    const p = r.payload || {};
    updatedAt = r.timestamp || updatedAt;
    if (r.type === 'turn_context') model = p.model || model;
    if (r.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        const text = cleanUserText(textOf(p));
        if (text) { turns++; if (!firstUser) firstUser = text.slice(0, 90); }
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call') tools++;
    }
    if (r.type === 'event_msg') {
      if (p.type === 'task_started' || p.type === 'turn_started') status = 'running';
      if (['task_complete', 'task_completed', 'turn_complete', 'turn_completed'].includes(p.type)) status = 'completed';
      if (['turn_aborted', 'task_aborted'].includes(p.type)) status = 'cancelled';
    }
  }
  return { id: meta.id, title: (firstUser || '未命名会话').split('\n').find(line => line.trim())?.slice(0, 90), cwd: meta.cwd || '', model: model || meta.model || null, provider: meta.model_provider, created_at: meta.timestamp, updated_at: updatedAt, status, user_turns: turns, tool_calls: tools };
}

async function peek(path) {
  // Initial metadata is enough to reject unrelated chats without reading their contents.
  for await (const record of records(path)) {
    if (record.type === 'session_meta') return metadataOf(record.payload);
    break;
  }
  return null;
}

async function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const directories = [root];
  while (directories.length) {
    const dir = directories.pop();
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      if (item.isDirectory()) directories.push(join(dir, item.name));
      else if (item.isFile() && /\.jsonl(?:\.zst)?$/.test(item.name)) result.push(join(dir, item.name));
    }
  }
  return result;
}

export class SessionRepository {
  constructor({ stateDir, codexHome }) {
    this.stateDir = resolve(stateDir);
    this.codexHome = resolve(codexHome);
    this.fileCache = new Map();
    this.parsedCache = new Map();
    this.index = new Map();
    this.lastScan = 0;
    this.scanPromise = null;
    this.overridesPath = join(this.stateDir, 'viewer', 'session-metadata.json');
    mkdirSync(join(this.stateDir, 'viewer'), { recursive: true });
    this.cachePath = join(this.stateDir, 'viewer', 'index-cache.json');
    try { this.fileCache = new Map(JSON.parse(readFileSync(this.cachePath, 'utf8'))); } catch {}
  }

  overrides() {
    try { return JSON.parse(readFileSync(this.overridesPath, 'utf8')); } catch { return {}; }
  }

  async parsed(path) {
    const stat = statSync(path);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const previous = this.parsedCache.get(path);
    if (previous?.signature === signature) return previous.value;
    const value = await parseRollout(path);
    const bytes = value.entries.reduce((sum, entry) => sum + (entry.text?.length || 0) + (entry.output?.length || 0) + plain(entry.arguments).length, 0) * 2;
    if (bytes < 8_000_000) this.parsedCache.set(path, { signature, value, bytes });
    // The sidebar retains no transcripts; open transcript caches have a byte budget.
    while (this.parsedCache.size > 4 || [...this.parsedCache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 16_000_000) this.parsedCache.delete(this.parsedCache.keys().next().value);
    return value;
  }

  jobs() {
    const jobs = [];
    const root = join(this.stateDir, 'jobs');
    if (!existsSync(root)) return jobs;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try {
        const job = JSON.parse(readFileSync(join(root, entry.name, 'job.json'), 'utf8'));
        if (job.job_id === entry.name) jobs.push(job);
      } catch {}
    }
    return jobs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async refresh(force = false) {
    if (this.scanPromise) return this.scanPromise;
    if (!force && Date.now() - this.lastScan < 2000) return;
    this.scanPromise = this.scan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  async scan() {
    let cacheDirty = false;
    const grouped = new Map();
    const jobsInScope = this.jobs();
    for (const job of jobsInScope) {
      const id = job.session_id || job.job_id;
      if (!ID.test(id)) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(job);
    }
    const registeredKeys = new Set([...grouped.keys(), ...jobsInScope.map(job => job.job_id)]);
    for (const [path, cached] of this.fileCache) {
      if (!grouped.has(cached.meta?.id)) { this.fileCache.delete(path); cacheDirty = true; }
    }
    const next = new Map();
    const files = grouped.size ? [...await walk(join(this.codexHome, 'sessions')), ...await walk(join(this.codexHome, 'archived_sessions'))] : [];
    for (const path of files) {
      const candidateId = basename(path).match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/i)?.[1];
      if (!grouped.has(candidateId)) continue;
      try {
        const stat = statSync(path);
        const signature = `${stat.size}:${stat.mtimeMs}`;
        let cached = this.fileCache.get(path);
        if (!cached || cached.signature !== signature || (!cached.brief && grouped.has(cached.meta?.id))) {
          const meta = cached?.meta || await peek(path);
          const eligible = meta && meta.id === candidateId && grouped.has(meta.id);
          let brief = null;
          if (eligible) {
            brief = await inspectRollout(path, meta);
            brief.created_at ||= new Date(stat.birthtimeMs).toISOString();
            brief.updated_at ||= new Date(stat.mtimeMs).toISOString();
          }
          cached = { signature, meta, brief };
          this.fileCache.set(path, cached);
          cacheDirty = true;
        }
        if (cached.brief && cached.meta?.id === candidateId && grouped.has(cached.meta.id)) {
          const existing = next.get(cached.brief.id);
          if (!existing || cached.brief.updated_at > existing.updated_at) next.set(cached.brief.id, { ...cached.brief, path });
        }
      } catch {}
    }
    for (const [id, jobs] of grouped) {
      const last = jobs.at(-1);
      const first = jobs[0];
      const native = next.get(id);
      next.set(id, {
        id, title: native?.title || first.title || '未命名会话', cwd: last.cwd,
        model: last.model || native?.model || null, provider: last.connection_name || last.profile || native?.provider || null,
        connection_id: last.connection_id || null, connection_name: last.connection_name || null,
        created_at: native?.created_at || first.started_at, updated_at: last.finished_at || native?.updated_at || last.started_at,
        status: active.has(last.status) && !this.ownerAlive(last.owner_pid) ? 'interrupted' : last.status,
        user_turns: native?.user_turns || jobs.length, tool_calls: native?.tool_calls || 0,
        path: native?.path || null, jobs, source: 'bridge',
      });
    }
    const overrides = this.overrides();
    let overridesDirty = false;
    for (const id of Object.keys(overrides)) {
      if (!registeredKeys.has(id)) { delete overrides[id]; overridesDirty = true; }
    }
    if (overridesDirty) {
      const temp = this.overridesPath + '.tmp';
      writeFileSync(temp, JSON.stringify(overrides), { mode: 0o600 });
      renameSync(temp, this.overridesPath);
    }
    for (const item of next.values()) {
      item.source = 'bridge';
      item.project = projectName(item.cwd);
      item.project_id = createHash('sha256').update(item.cwd.toLowerCase()).digest('hex').slice(0, 12);
      item.title = overrides[item.id]?.title || item.title;
      item.pinned = Boolean(overrides[item.id]?.pinned);
    }
    this.index = next;
    this.lastScan = Date.now();
    if (cacheDirty) {
      const temp = this.cachePath + '.tmp';
      writeFileSync(temp, JSON.stringify([...this.fileCache].filter(([, value]) => value.brief)), { mode: 0o600 });
      renameSync(temp, this.cachePath);
    }
  }

  ownerAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  summary(item) {
    const { path, jobs, ...publicPart } = item;
    return { ...publicPart, job_ids: (jobs || []).map(job => job.job_id) };
  }

  async list() {
    await this.refresh();
    return [...this.index.values()].map(item => this.summary(item))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async get(id, { before, limit = 100, full = false } = {}) {
    if (!ID.test(id)) throw Object.assign(new Error('会话编号无效。'), { status: 400 });
    await this.refresh();
    let item = this.index.get(id) || [...this.index.values()].find(candidate => candidate.jobs?.some(job => job.job_id === id));
    if (!item) throw Object.assign(new Error('未找到该会话。'), { status: 404 });
    let transcript;
    if (item.path) transcript = full ? await parseRollout(item.path, { full: true }) : await this.parsed(item.path);
    else {
      const entries = [];
      for (const job of item.jobs || []) {
        const historyPath = join(this.stateDir, 'jobs', job.job_id, 'history.jsonl');
        if (existsSync(historyPath)) {
          const items = new Map();
          for await (const event of records(historyPath)) {
            if (event.kind === 'user') entries.push({ kind: 'user', at: event.at, text: event.text });
            else if (event.item && ['agent_message', 'command_execution', 'file_change', 'mcp_tool_call'].includes(event.item.type)) {
              const p = event.item;
              let entry = items.get(p.id);
              if (!entry) { entry = {}; entries.push(entry); items.set(p.id, entry); }
              Object.assign(entry, p.type === 'agent_message'
                ? { kind: 'assistant', at: event.at, text: p.text || '' }
                : { kind: 'tool', at: event.at, name: p.type, arguments: p.command || p.arguments || p.changes || '', output: p.aggregated_output || p.result || '', status: p.status || 'running' });
            }
          }
        } else {
          if (job.prompt) entries.push({ kind: 'user', at: job.started_at, text: job.prompt });
          try { const text = readFileSync(join(this.stateDir, 'jobs', job.job_id, 'result.txt'), 'utf8'); if (text) entries.push({ kind: 'assistant', at: job.finished_at, text }); } catch {}
        }
      }
      entries.forEach((entry, i) => { entry.id = `entry-${i}`; });
      transcript = { entries, usage: null };
    }
    const all = transcript.entries;
    const end = before === undefined ? all.length : Number(before);
    if (!Number.isInteger(end) || end < 0 || end > all.length || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw Object.assign(new Error('分页参数无效。'), { status: 400 });
    }
    const start = full ? 0 : Math.max(0, end - limit);
    const selected = all.slice(start, full ? all.length : end);
    const usage = combinedUsage(item.jobs) || (transcript.usage && Object.values(transcript.usage).some(n => typeof n === 'number' && n > 0) ? { status: 'reported', ...transcript.usage } : { status: 'unavailable' });
    return {
      session: this.summary(item), entries: selected, total_entries: all.length,
      earlier_cursor: start > 0 ? start : null, usage,
      jobs: (item.jobs || []).map(job => ({ job_id: job.job_id, status: job.status, started_at: job.started_at, finished_at: job.finished_at, usage: job.usage })),
    };
  }

  async toolOutput(id, entryId) {
    if (!ID.test(id) || !/^entry-\d+$/.test(entryId)) throw Object.assign(new Error('条目编号无效。'), { status: 400 });
    await this.refresh();
    const item = this.index.get(id);
    if (!item?.path) throw Object.assign(new Error('未找到该会话的原生日志。'), { status: 404 });
    const entry = (await this.parsed(item.path)).entries.find(entry => entry.id === entryId && entry.kind === 'tool');
    if (!entry) throw Object.assign(new Error('未找到该工具记录。'), { status: 404 });
    for await (const record of records(item.path)) {
      const p = record.payload || {};
      if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type) && p.call_id === entry.call_id) return plain(p.output);
    }
    return '';
  }

  async update(id, patch) {
    await this.get(id, { limit: 1 });
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 120)) throw Object.assign(new Error('会话名称需为 1–120 个字符。'), { status: 400 });
    if (patch.pinned !== undefined && typeof patch.pinned !== 'boolean') throw Object.assign(new Error('置顶状态无效。'), { status: 400 });
    const metadata = this.overrides();
    metadata[id] = { ...metadata[id] };
    if (patch.title !== undefined) metadata[id].title = patch.title.trim();
    if (patch.pinned !== undefined) metadata[id].pinned = patch.pinned;
    const temp = this.overridesPath + '.tmp';
    writeFileSync(temp, JSON.stringify(metadata), { mode: 0o600 });
    renameSync(temp, this.overridesPath);
    this.lastScan = 0;
    await this.refresh();
    return this.summary(this.index.get(id));
  }
}
