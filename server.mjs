#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { JobManager } from './runtime.mjs';
import { ensureViewer } from './viewer-client.mjs';

export function toolDefinition(manager) {
  return {
    name: 'codex_subagent',
    description: 'Delegate work to a configured local/API/router model. models lists configured connections; omit connection_id/model to use website settings. start runs in background, wait/status check progress, resume continues the original connection, cancel stops a task, viewer returns the local workspace. run waits synchronously. Provide a self-contained prompt. Official routing is unchanged.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['run', 'start', 'status', 'wait', 'cancel', 'resume', 'result', 'list', 'viewer', 'models'], description: 'Default run. start/resume return a job_id immediately. models lists enabled connections; pass connection_id to inspect one, including a disabled connection.' },
        prompt: { type: 'string', description: 'Required for run/start/resume. Task or follow-up.' },
        job_id: { type: 'string', description: 'Required for status/wait/cancel/resume/result.' },
        cwd: { type: 'string', description: 'Existing absolute working directory; resume keeps the original.' },
        connection_id: { type: 'string', description: 'Configured connection ID from models. Omit to use the website default.' },
        model: { type: 'string', description: 'Optional model ID override; defaults to the selected connection model.' },
        profile: { type: 'string', description: 'Optional explicit Codex profile override. Omit for website defaults; mutually exclusive with connection_id.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Default workspace-write.' },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 86400, description: 'Execution timeout, default 900.' },
        wait_sec: { type: 'integer', minimum: 0, maximum: 30, description: 'wait only, default 25; does not stop the task.' },
        max_output_chars: { type: 'integer', minimum: 256, maximum: 16000, description: `Reply/page size, default ${manager.defaultOutputChars}. Full result stays on disk.` },
        offset: { type: 'integer', minimum: 0, description: 'result pagination; use next_offset from the previous page.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list only, default 10.' },
      },
    },
  };
}

export function startServer(options = {}) {
  const manager = options.manager || new JobManager({ stateDir: process.env.CODEX_SUBAGENT_STATE_DIR || join(dirname(fileURLToPath(import.meta.url)), 'state') });
  const viewerEnabled = options.viewer ?? (!options.manager && process.env.CODEX_SUBAGENT_VIEWER_ENABLED !== 'false');
  let viewerUrl = null;
  let viewerError = null;
  const viewerReady = viewerEnabled ? ensureViewer({ stateDir: manager.stateDir }).then(url => { viewerUrl = url; }).catch(error => { viewerError = error.message; }) : Promise.resolve();
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const requests = new Map();
  let outputOpen = true;
  const send = message => { if (outputOpen) output.write(`${JSON.stringify(message)}\n`); };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await manager.shutdown();
  }
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      failure(null, -32600, 'Invalid Request'); return;
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const jobId = requests.get(params?.requestId);
        if (jobId) await manager.stop(jobId);
      }
      return;
    }
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codex-subagent', version: '4.0.0' } });
        return;
      case 'ping': reply(id, {}); return;
      case 'tools/list': reply(id, { tools: [toolDefinition(manager)] }); return;
      case 'tools/call': {
        if (params?.name !== 'codex_subagent') { failure(id, -32602, 'Unknown tool'); return; }
        const args = params.arguments || {};
        try {
          if (viewerEnabled && ['run', 'start', 'resume'].includes(args.action || 'run')) {
            await viewerReady;
            const parent = args.action === 'resume' ? manager.load(args.job_id) : null;
            const connection = manager.modelStore.select(args, parent).connection;
            if (connection && connection.kind !== 'profile' && !viewerUrl) throw new Error(viewerError || '本机模型网关尚未启动。');
          }
          // Keep legacy synchronous requests cancellable at the MCP transport level.
          let result;
          if (args.action === 'viewer') {
            await viewerReady;
            if (!viewerUrl) throw new Error(viewerError || '当前连接未启用本机工作区，无法获取地址。');
            result = { viewer_url: viewerUrl };
          } else if (!args.action || args.action === 'run') {
            const jobId = manager.start(args);
            requests.set(id, jobId);
            do { result = await manager.wait(jobId, 30); }
            while (['running', 'cancelling'].includes(result.status));
          } else result = await manager.call(args);
          if (viewerUrl && result.job_id) result.viewer_url = `${viewerUrl}/#/session/${result.session_id || result.job_id}`;
          reply(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: ['failed', 'timed_out', 'interrupted'].includes(result.status),
          });
        } catch (error) {
          reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }], isError: true });
        } finally { requests.delete(id); }
        return;
      }
      default: failure(id, -32601, `Unknown method: ${String(method).slice(0, 100)}`);
    }
  }
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { failure(null, -32700, 'Parse error'); return; }
    void handle(message).catch(error => {
      if (message?.id !== undefined) failure(message.id, -32603, error.message);
    });
  });
  lines.on('close', () => { void close(); });
  output.on('error', () => { outputOpen = false; lines.close(); });
  process.once('SIGINT', () => { lines.close(); });
  process.once('SIGTERM', () => { lines.close(); });
  return { manager, close };
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) startServer();
