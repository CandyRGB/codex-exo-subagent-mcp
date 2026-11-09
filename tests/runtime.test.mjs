import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { JobManager } from '../runtime.mjs';

const suiteRoot = fileURLToPath(new URL('../.test-runs/', import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
function directory() {
  const path = join(suiteRoot, randomUUID());
  mkdirSync(path, { recursive: true });
  return path;
}
function manager(t, overrides = {}) {
  const instance = new JobManager({
    codexBin: process.execPath, codexArgs: [fakeCodex], stateDir: directory(),
    env: { ...process.env, CODEX_SUBAGENT_DEPTH: '0', CODEX_SUBAGENT_MAX_CONCURRENT: '2' },
    ...overrides,
  });
  t.after(() => instance.shutdown());
  return instance;
}
const prompt = spec => JSON.stringify(spec);
const sleep = ms => new Promise(done => setTimeout(done, ms));

test('legacy prompt waits, sends task through stdin, keeps route, sandbox and depth', async t => {
  const m = manager(t);
  const result = await m.call({ prompt: prompt({ reportArgs: true }), cwd: directory(), sandbox: 'read-only' });
  assert.equal(result.status, 'completed');
  const actual = JSON.parse(result.result.text);
  assert.equal(actual.argv.at(-1), '-');
  assert.ok(!actual.argv.some(arg => arg.includes('reportArgs')));
  assert.equal(actual.argv[actual.argv.indexOf('--profile') + 1], 'workbuddy');
  assert.equal(actual.argv[actual.argv.indexOf('--model') + 1], 'deepseek-v4.1-flash');
  assert.equal(actual.argv[actual.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(actual.argv.includes('mcp_servers.codex-subagent.enabled=false'));
  assert.equal(actual.depth, '1');
  assert.equal(result.usage.status, 'reported');
  assert.equal(result.usage.input_tokens, 101);
  assert.equal(result.progress.completed_commands, 1);
});

test('background task is queryable, bounded wait does not cancel, and status omits result/logs', async t => {
  const m = manager(t);
  const started = await m.call({ action: 'start', prompt: prompt({ delay: 500, text: 'DONE' }) });
  assert.equal(started.status, 'running');
  const pending = await m.call({ action: 'wait', job_id: started.job_id, wait_sec: 0 });
  assert.equal(pending.status, 'running');
  assert.ok(!('result' in pending));
  const done = await m.call({ action: 'wait', job_id: started.job_id, wait_sec: 5 });
  assert.equal(done.result.text, 'DONE');
  const status = await m.call({ action: 'status', job_id: started.job_id });
  assert.ok(!('result' in status));
  assert.ok(!JSON.stringify(status).includes('PRIVATE_TOOL_OUTPUT'));
});

test('long replies are limited and can be reconstructed without losing full result', async t => {
  const m = manager(t);
  const text = '甲乙😀'.repeat(500);
  const result = await m.call({ prompt: prompt({ text }), max_output_chars: 257 });
  assert.ok(result.result.text.length <= 257);
  assert.equal(result.result.truncated, true);
  let combined = result.result.text;
  let offset = result.result.next_offset;
  while (offset !== null) {
    const page = await m.call({ action: 'result', job_id: result.job_id, offset, max_output_chars: 257 });
    combined += page.result.text;
    offset = page.result.next_offset;
  }
  assert.equal(combined, text);
  assert.equal(readFileSync(result.result.path, 'utf8'), text);
});

test('zero usage means unavailable, never a zero-cost claim; oversized logs stay bounded', async t => {
  const m = manager(t);
  const result = await m.call({ prompt: prompt({ zeroUsage: true, oversized: true }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage.status, 'unavailable');
  assert.equal(result.usage.reason, 'provider_returned_zero_or_missing_usage');
  assert.equal(result.progress.oversized_events, 1);
  assert.equal(result.result.text, 'FAKE_OK');
});

test('completed sessions survive manager restart; resume keeps routing and serializes the session', async t => {
  const firstManager = manager(t);
  const first = await firstManager.call({ prompt: prompt({ text: 'FIRST' }), cwd: directory(), sandbox: 'read-only' });
  await firstManager.shutdown();
  const nextManager = manager(t, { stateDir: firstManager.stateDir });
  assert.equal(nextManager.view(first.job_id, true).result.text, 'FIRST');
  const resumed = await nextManager.call({ action: 'resume', job_id: first.job_id, prompt: prompt({ delay: 300, reportArgs: true }) });
  await assert.rejects(nextManager.call({ action: 'resume', job_id: first.job_id, prompt: '{}' }), /already has an active task/);
  const done = await nextManager.call({ action: 'wait', job_id: resumed.job_id, wait_sec: 5 });
  assert.equal(done.session_id, first.session_id);
  assert.equal(done.parent_job_id, first.job_id);
  const actual = JSON.parse(done.result.text);
  assert.equal(actual.argv[actual.argv.indexOf('resume') + 1], first.session_id);
  assert.equal(actual.argv[actual.argv.indexOf('--sandbox') + 1], 'read-only');
  await assert.rejects(nextManager.call({ action: 'resume', job_id: first.job_id, prompt: '{}', profile: 'other' }), /original profile/);
});

test('cancel terminates the process tree and is idempotent', async t => {
  const m = manager(t);
  const pidPath = join(directory(), 'grandchild.pid');
  const started = await m.call({ action: 'start', prompt: prompt({ delay: 10000, grandchildPath: pidPath }) });
  for (let i = 0; i < 100 && !existsSync(pidPath); i++) await sleep(25);
  assert.ok(existsSync(pidPath), 'fixture grandchild started');
  const pid = Number(readFileSync(pidPath, 'utf8'));
  const result = await m.call({ action: 'cancel', job_id: started.job_id });
  assert.equal(result.status, 'cancelled');
  await sleep(100);
  assert.throws(() => process.kill(pid, 0));
  assert.equal((await m.call({ action: 'cancel', job_id: started.job_id })).status, 'cancelled');
});

test('timeout stops the child; CLI failures propagate even with exit code zero', async t => {
  const m = manager(t);
  const timedOut = await m.call({ prompt: prompt({ delay: 10000 }), timeout_sec: 1 });
  assert.equal(timedOut.status, 'timed_out');
  const failed = await m.call({ prompt: prompt({ fail: true, exitZero: true, error: 'Bearer secret12345' }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Bearer <REDACTED>');
});

test('invalid cwd, IDs, limits, recursion, missing binaries fail explicitly', async t => {
  const m = manager(t);
  await assert.rejects(m.call({ prompt: '{}', cwd: 'relative' }), /existing absolute directory/);
  await assert.rejects(m.call({ action: 'status', job_id: '../outside' }), /UUID/);
  await assert.rejects(m.call({ prompt: '{}', timeout_sec: -1 }), /timeout_sec/);
  await assert.rejects(m.call({ action: 'wait', job_id: randomUUID(), wait_sec: 31 }), /wait_sec/);
  const nested = manager(t, { env: { ...process.env, CODEX_SUBAGENT_DEPTH: '2' } });
  await assert.rejects(nested.call({ prompt: '{}' }), /nesting limit/);
  const missing = manager(t, { codexBin: join(directory(), 'missing-executable') });
  const failure = await missing.call({ prompt: '{}' });
  assert.equal(failure.status, 'failed');
  assert.match(failure.error, /ENOENT/);
});

test('concurrency cap rejects excess tasks; shutdown records interruption', async t => {
  const m = manager(t);
  const first = await m.call({ action: 'start', prompt: prompt({ delay: 10000 }) });
  const second = await m.call({ action: 'start', prompt: prompt({ delay: 10000 }) });
  await assert.rejects(m.call({ action: 'start', prompt: '{}' }), /Concurrency limit/);
  await m.shutdown();
  assert.equal(m.view(first.job_id).status, 'interrupted');
  assert.equal(m.view(second.job_id).status, 'interrupted');
  assert.equal(m.list().jobs.length, 2);
});

test('abandoned job is interrupted, and a live foreign owner cannot be killed', async t => {
  const m = manager(t);
  const result = await m.call({ prompt: '{}' });
  const path = join(m.jobDir(result.job_id), 'job.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  stored.status = 'running';
  stored.owner_pid = -1;
  writeFileSync(path, JSON.stringify(stored));
  assert.equal(m.view(result.job_id).status, 'interrupted');
  stored.owner_pid = process.pid;
  writeFileSync(path, JSON.stringify(stored));
  await assert.rejects(m.stop(result.job_id), /originating chat/);
});

test('MCP stdio handshake, compact single-tool schema, async execution, and disconnect cleanup', async t => {
  const stateDir = directory();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixture-server.mjs', import.meta.url))], {
    env: { ...process.env, TEST_STATE_DIR: stateDir, CODEX_SUBAGENT_DEPTH: '0' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise(done => child.once('exit', done));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { child.stdin.end(); await exit; });
  const replies = new Map();
  let seq = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    const listener = replies.get(response.id);
    assert.ok(listener, 'stdout contains JSON-RPC replies only');
    replies.delete(response.id);
    listener(response);
  });
  const rpc = (method, params) => new Promise(done => {
    const id = ++seq;
    replies.set(id, done);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async args => {
    const response = await rpc('tools/call', { name: 'codex_subagent', arguments: args });
    assert.ok(!response.error, JSON.stringify(response));
    return { ...JSON.parse(response.result.content[0].text), isError: response.result.isError };
  };
  const initialized = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.version, '4.0.0');
  const tools = (await rpc('tools/list')).result.tools;
  assert.equal(tools.length, 1);
  assert.ok(tools[0].inputSchema.properties.action.enum.includes('resume'));
  assert.equal((await tool({ prompt: prompt({ text: 'MCP_OK' }) })).result.text, 'MCP_OK');
  const started = await tool({ action: 'start', prompt: prompt({ delay: 10000 }) });
  assert.equal(started.status, 'running');
  assert.equal((await rpc('ping')).result.constructor, Object);
  assert.equal((await tool({ action: 'cancel', job_id: started.job_id })).status, 'cancelled');
  const requestId = seq + 1;
  const synchronous = rpc('tools/call', { name: 'codex_subagent', arguments: { prompt: prompt({ delay: 10000 }) } });
  await sleep(250);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }) + '\n');
  const cancelled = await synchronous;
  assert.equal(JSON.parse(cancelled.result.content[0].text).status, 'cancelled');
  const interrupted = await tool({ action: 'start', prompt: prompt({ delay: 10000 }) });
  child.stdin.end();
  await exit;
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'jobs', interrupted.job_id, 'job.json'), 'utf8')).status, 'interrupted');
  assert.equal(stderr, '');
});

test('installed entry point starts through a Windows junction or directory symlink', async t => {
  const root = directory();
  const actual = join(root, 'actual');
  const alias = join(root, 'alias');
  mkdirSync(actual);
  copyFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), join(actual, 'server.mjs'));
  copyFileSync(fileURLToPath(new URL('../runtime.mjs', import.meta.url)), join(actual, 'runtime.mjs'));
  for (const file of ['viewer-client.mjs', 'viewer.mjs', 'history.mjs', 'model-store.mjs', 'model-gateway.mjs', 'model-config.mjs', 'profile-export.mjs', 'reasoning.mjs']) copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(actual, file));
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawn(process.execPath, [join(alias, 'server.mjs')], {
    env: { ...process.env, CODEX_SUBAGENT_STATE_DIR: join(root, 'state'), CODEX_SUBAGENT_VIEWER_ENABLED: 'false' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(done => child.once('exit', done));
  t.after(async () => { child.stdin.end(); await exited; });
  const response = new Promise((done, reject) => {
    createInterface({ input: child.stdout }).once('line', line => done(JSON.parse(line)));
    child.once('exit', code => reject(new Error(`Entry point exited before MCP initialization: ${code}`)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  assert.equal((await response).result.serverInfo.version, '4.0.0');
});
