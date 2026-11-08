import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const serverPath = resolve(process.argv[2] || fileURLToPath(new URL('../server.mjs', import.meta.url)));
const stateDir = resolve(process.argv[3] || fileURLToPath(new URL('../.real-smoke-state', import.meta.url)));
const cwd = resolve(process.argv[4] || process.cwd());
const reportPath = process.argv[5] && resolve(process.argv[5]);
const nonce = `MEMORY_${randomUUID()}`;
const startChild = () => spawn(process.execPath, [serverPath], {
  env: { ...process.env, CODEX_SUBAGENT_STATE_DIR: stateDir, CODEX_SUBAGENT_DEPTH: '0', CODEX_SUBAGENT_VIEWER_ENABLED: 'false' },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let child = startChild();
let exited = new Promise(done => child.once('exit', done));
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
const pending = new Map();
let seq = 0;
const attachReplies = () => readline.createInterface({ input: child.stdout }).on('line', line => {
  const response = JSON.parse(line);
  const handler = pending.get(response.id);
  if (handler) { pending.delete(response.id); handler(response); }
});
attachReplies();
function rpc(method, params) {
  return new Promise((resolveReply, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 40000);
    pending.set(id, response => { clearTimeout(timer); resolveReply(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(args) {
  const response = await rpc('tools/call', { name: 'codex_subagent', arguments: args });
  assert.ok(!response.error, JSON.stringify(response.error));
  const value = JSON.parse(response.result.content[0].text);
  assert.ok(!response.result.isError, JSON.stringify(value));
  return value;
}
async function wait(id) {
  let result;
  do {
    result = await tool({ action: 'wait', job_id: id, wait_sec: 25 });
    console.log(JSON.stringify({ job: id, status: result.status, progress: result.progress, usage: result.usage }));
  } while (['running', 'cancelling'].includes(result.status));
  assert.equal(result.status, 'completed');
  return result;
}
try {
  const initialized = (await rpc('initialize', { protocolVersion: '2024-11-05' })).result;
  assert.equal(initialized.serverInfo.version, '4.0.0');
  const schema = (await rpc('tools/list')).result.tools;
  assert.equal(schema.length, 1);
  const first = await tool({
    action: 'start', cwd, sandbox: 'read-only', timeout_sec: 120,
    prompt: `这是已授权的 MCP 测试。只读操作，不要创建、修改或删除任何文件。请在这段会话里记住随机字符串 ${nonce}，但这轮不要输出这个字符串。请通过 shell 确认当前目录并计算 17 * 23。最终只回复 FIRST_OK 391。`,
  });
  console.log(JSON.stringify({ async_start: first.status, job_id: first.job_id, model: first.model, profile: first.profile }));
  const firstResult = await wait(first.job_id);
  assert.match(firstResult.result.text, /FIRST_OK\s+391/);
  assert.ok(firstResult.progress.completed_commands >= 1, 'real agent executed a shell command');
  child.stdin.end();
  await exited;
  child = startChild();
  exited = new Promise(done => child.once('exit', done));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  attachReplies();
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const restored = await tool({ action: 'result', job_id: first.job_id });
  assert.equal(restored.result.text, firstResult.result.text);
  const resumed = await tool({
    action: 'resume', job_id: first.job_id, timeout_sec: 120,
    prompt: '上一轮让你记住且不要输出的随机字符串是什么？请依靠上一轮会话记忆回答，不要读文件，不要执行任何工具。最终只输出这个字符串。',
  });
  const resumedResult = await wait(resumed.job_id);
  assert.equal(resumedResult.result.text.trim(), nonce);
  assert.equal(resumedResult.session_id, firstResult.session_id);
  const report = {
    passed: true, server_version: initialized.serverInfo.version,
    model: firstResult.model, profile: firstResult.profile, session_id: firstResult.session_id,
    job_ids: [firstResult.job_id, resumedResult.job_id],
    async_start: first.status === 'running', actual_shell_task: true,
    survived_mcp_process_restart: true, remembered_random_nonce_after_resume: true,
    session_id_preserved: true, initial_usage: firstResult.usage,
    resumed_usage: resumedResult.usage, stderr_empty: stderr.length === 0,
    tested_at: new Date().toISOString(),
  };
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
  assert.equal(stderr, '');
  console.log(JSON.stringify(report));
} finally {
  child.stdin.end();
  await exited;
  if (stderr) console.error(stderr);
}
