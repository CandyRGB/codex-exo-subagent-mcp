import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { get as httpGet } from 'node:http';
import { SessionRepository, parseRollout } from '../history.mjs';
import { createViewer } from '../viewer.mjs';
import { JobManager } from '../runtime.mjs';

function fixture() {
  const root = fileURLToPath(new URL(`../.test-runs/history-${randomUUID()}/`, import.meta.url));
  const stateDir = join(root, 'state'); const codexHome = join(root, 'codex');
  mkdirSync(join(stateDir, 'jobs'), { recursive: true }); mkdirSync(join(codexHome, 'sessions', '2026', '11', '08'), { recursive: true });
  return { root, stateDir, codexHome };
}
const at = '2026-11-08T14:28:00.000Z';
function register(f, native) {
  const id = randomUUID(); const dir = join(f.stateDir, 'jobs', id); mkdirSync(dir);
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ job_id: id, session_id: native.id, model: 'deepseek-v4.1-flash', profile: 'workbuddy', cwd: 'E:\\Projects\\example', started_at: at, finished_at: at, status: 'completed', usage: { status: 'unavailable' } }));
  return id;
}
function rollout(f, { id = randomUUID(), provider = 'workbuddy', source = 'exec', compressed = false } = {}) {
  const records = [
    { type: 'session_meta', payload: { id, model_provider: provider, source, cwd: 'E:\\Projects\\example', timestamp: at }, timestamp: at },
    { type: 'turn_context', payload: { model: 'deepseek-v4.1-flash' }, timestamp: at },
    { type: 'event_msg', payload: { type: 'task_started' }, timestamp: at },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_SYSTEM_INSTRUCTIONS' }] }, timestamp: at },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_ENV</environment_context>' }] }, timestamp: at },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Complete the task below. helper\n\nTask:\n检查构建错误' }] }, timestamp: at },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'PRIVATE_REASONING' }, timestamp: at },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: 'node --version' }) }, timestamp: at },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 0\nOutput:\nv24.19.0' }, timestamp: at },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '**检查通过**\n\n```js\nconsole.log("ok");\n```' }] }, timestamp: at },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate final' }, timestamp: at },
    { type: 'event_msg', payload: { type: 'task_complete' }, timestamp: at },
  ];
  const path = join(f.codexHome, 'sessions', '2026', '11', '08', `rollout-${id}.jsonl${compressed ? '.zst' : ''}`);
  const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, compressed ? zstdCompressSync(text) : text);
  return { id, path, records };
}

test('native transcript removes injected context and reasoning, pairs tools, and deduplicates final messages', async () => {
  const f = fixture(); const native = rollout(f);
  const parsed = await parseRollout(native.path);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.entries[0].text, '检查构建错误');
  assert.equal(parsed.entries[1].arguments.cmd, 'node --version');
  assert.equal(parsed.entries[1].exit_code, 0);
  assert.equal(parsed.entries[1].status, 'completed');
  assert.equal(parsed.status, 'completed');
  assert.ok(!JSON.stringify(parsed.entries).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(parsed.entries).includes('duplicate final'));
});

test('only registered MCP sessions are visible; matching legacy providers do not grant access', async () => {
  const f = fixture(); const expected = rollout(f); register(f, expected); const legacy = rollout(f); const official = rollout(f, { provider: 'openai' }); rollout(f, { source: 'vscode' });
  const repo = new SessionRepository(f); const sessions = await repo.list();
  assert.equal(sessions.length, 1); assert.equal(sessions[0].id, expected.id); assert.equal(sessions[0].project, 'example');
  await assert.rejects(repo.get(official.id), /not found/);
  await assert.rejects(repo.get(legacy.id), /not found/);
  await assert.rejects(repo.get(legacy.id, { full: true }), /not found/);
  await assert.rejects(repo.toolOutput(legacy.id, 'entry-1'), /not found/);
  await assert.rejects(repo.get('../outside'), /Invalid session ID/);
});

test('preexisting legacy summaries and display metadata cannot survive outside the MCP registry', async () => {
  const f = fixture(); const legacy = rollout(f); const stat = statSync(legacy.path);
  const viewerDir = join(f.stateDir, 'viewer'); mkdirSync(viewerDir);
  writeFileSync(join(viewerDir, 'index-cache.json'), JSON.stringify([[legacy.path, { signature: `${stat.size}:${stat.mtimeMs}`, meta: legacy.records[0].payload, brief: { id: legacy.id, title: '旧版记录', cwd: 'E:\\Projects\\example', model: 'deepseek-v4.1-flash', provider: 'workbuddy', created_at: at, updated_at: at, status: 'completed', user_turns: 1, tool_calls: 1 } }]]));
  writeFileSync(join(viewerDir, 'session-metadata.json'), JSON.stringify({ [legacy.id]: { title: '旧版名称', pinned: true } }));
  const repo = new SessionRepository(f);
  assert.deepEqual(await repo.list(), []);
  await assert.rejects(repo.get(legacy.id), /not found/);
  assert.deepEqual(JSON.parse(readFileSync(join(viewerDir, 'index-cache.json'), 'utf8')), []);
  assert.deepEqual(JSON.parse(readFileSync(join(viewerDir, 'session-metadata.json'), 'utf8')), {});
});

test('compressed logs, earlier-page loading, export and display metadata preserve original transcripts', async () => {
  const f = fixture(); const native = rollout(f, { compressed: true }); register(f, native); const repo = new SessionRepository(f);
  const original = readFileSync(native.path);
  const page = await repo.get(native.id, { limit: 2 });
  assert.equal(page.entries.length, 2); assert.equal(page.earlier_cursor, 1);
  const first = await repo.get(native.id, { before: 1, limit: 2 }); assert.equal(first.entries[0].kind, 'user');
  assert.equal((await repo.get(native.id, { full: true })).entries.length, 3);
  await repo.update(native.id, { title: '自定义会话名称', pinned: true });
  const restored = new SessionRepository(f); const list = await restored.list();
  assert.equal(list[0].title, '自定义会话名称'); assert.equal(list[0].pinned, true);
  assert.deepEqual(readFileSync(native.path), original);
});

test('continued MCP jobs merge into one conversation and match native logs for other providers', async () => {
  const f = fixture(); const native = rollout(f, { provider: 'another-route' });
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(); mkdirSync(join(f.stateDir, 'jobs', id));
    writeFileSync(join(f.stateDir, 'jobs', id, 'job.json'), JSON.stringify({ job_id: id, session_id: native.id, model: 'custom', profile: 'another-route', cwd: 'E:\\Projects\\example', started_at: at, finished_at: at, status: 'completed', usage: { status: 'unavailable' } }));
  }
  const repo = new SessionRepository(f); const sessions = await repo.list();
  assert.equal(sessions.length, 1); assert.equal(sessions[0].source, 'bridge'); assert.equal(sessions[0].job_ids.length, 2);
  assert.equal((await repo.get(native.id)).entries.length, 3);
});

test('new jobs retain a viewable conversation even if native Codex history is unavailable', async t => {
  const f = fixture();
  const manager = new JobManager({ stateDir: f.stateDir, codexBin: process.execPath, codexArgs: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))], env: { ...process.env, CODEX_SUBAGENT_DEPTH: '0' } });
  t.after(() => manager.shutdown());
  const result = await manager.call({ prompt: JSON.stringify({ text: 'FALLBACK_RESULT' }) });
  const repo = new SessionRepository(f); const detail = await repo.get(result.session_id);
  assert.equal(detail.entries[0].kind, 'user');
  assert.ok(detail.entries.some(e => e.kind === 'tool' && String(e.output).includes('PRIVATE_TOOL_OUTPUT')));
  assert.equal(detail.entries.at(-1).text, 'FALLBACK_RESULT');
});

test('growing logs refresh the current conversation and tolerate incomplete last records', async () => {
  const f = fixture(); const native = rollout(f); register(f, native); const repo = new SessionRepository(f);
  await repo.list();
  const later = { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续检查' }] } };
  appendFileSync(native.path, JSON.stringify(later) + '\n{"type":');
  await repo.refresh(true);
  assert.equal((await repo.get(native.id)).entries.at(-1).text, '继续检查');
});

test('large tool output is previewed with a cap and remains downloadable or fully exportable', async () => {
  const f = fixture(); const native = rollout(f);
  register(f, native);
  native.records.find(r => r.payload?.type === 'function_call_output').payload.output = 'LARGE_OUTPUT\n' + 'x'.repeat(150000);
  writeFileSync(native.path, native.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const repo = new SessionRepository(f);
  await repo.list();
  assert.equal(repo.parsedCache.size, 0, 'sidebar indexing does not retain transcripts');
  const detail = await repo.get(native.id); const tool = detail.entries.find(e => e.kind === 'tool');
  assert.equal(tool.output.length, 64000); assert.equal(tool.output_truncated, true);
  assert.equal((await repo.toolOutput(native.id, tool.id)).length, 150013);
  const exported = await repo.get(native.id, { full: true });
  assert.equal(exported.entries.find(e => e.kind === 'tool').output.length, 150013);
});

test('frontend event bindings refer to real elements and all local assets are present', () => {
  const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
  const js = ['app.js', 'settings.js'].map(file => readFileSync(fileURLToPath(new URL(`../web/${file}`, import.meta.url)), 'utf8')).join('\n');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'element IDs are unique');
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(m[1]), `Missing bound element ${m[1]}`);
  for (const name of ['app.js', 'settings.js', 'style.css', 'settings.css', 'favicon.svg']) assert.ok(readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url))).length > 0);
});

test('HTTP serves real histories and assets; rejects foreign origins, DNS rebinding and traversal', async t => {
  const f = fixture(); const native = rollout(f); register(f, native); const legacy = rollout(f); const viewer = await createViewer({ ...f, port: 0 });
  t.after(() => viewer.close());
  const base = viewer.url;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await (await fetch(base + '/api/sessions')).json()).sessions.length, 1);
  const detail = await fetch(`${base}/api/sessions/${native.id}`); const etag = detail.headers.get('etag'); await detail.json();
  assert.equal((await fetch(`${base}/api/sessions/${native.id}`, { headers: { 'If-None-Match': etag } })).status, 304);
  const exportResponse = await fetch(`${base}/api/sessions/${native.id}/export`); assert.match(exportResponse.headers.get('content-disposition'), /attachment/); assert.equal((await exportResponse.json()).entries.length, 3);
  assert.equal((await fetch(base + '/api/sessions', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const foreignHostStatus = await new Promise((done, reject) => { httpGet(base + '/api/sessions', { headers: { Host: 'foreign.example' } }, response => { response.resume(); done(response.statusCode); }).on('error', reject); });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(base + '/api/sessions/not-a-uuid')).status, 400);
  assert.equal((await fetch(`${base}/api/sessions/${legacy.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/${legacy.id}/export`)).status, 404);
  assert.equal((await fetch(base + '/runtime.mjs')).status, 404);
  assert.equal((await fetch(`${base}/api/sessions/${native.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '浏览器修改标题' }) })).status, 200);
});
