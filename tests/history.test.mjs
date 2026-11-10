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
import { commandOutput, coalesceTerminalEntries, completeCommandOutput, groupCommandRuns, commandGroupOpen } from '../web/tool-output.js';
import { ModelSelection } from '../web/model-selection.js';

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
  for (const name of ['app.js', 'settings.js', 'dropdown.js', 'style.css', 'settings.css', 'favicon.svg']) assert.ok(readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url))).length > 0);
});

test('HTTP serves real histories and assets; rejects foreign origins, DNS rebinding and traversal', async t => {
  const f = fixture(); const native = rollout(f); register(f, native); const legacy = rollout(f); const viewer = await createViewer({ ...f, port: 0 });
  t.after(() => viewer.close());
  const base = viewer.url;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/dropdown.js')).status, 200);
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
test('command display removes transport metadata while preserving stdout and ordinary text', () => {
  const stdout = '391\nProcess exited with code 9\nOutput:\n保留原始内容\n';
  assert.equal(commandOutput('Chunk ID: 83046f\nWall time: 0.3305 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\n' + stdout), stdout);
  assert.equal(commandOutput('Process exited with code 1\r\nFinal output:\r\n错误信息\r\n'), '错误信息\r\n');
  assert.equal(commandOutput('Process running with session ID 42\nOutput:\nstarting…'), 'starting…');
  for (const text of ['Output:\n391', '普通输出\nProcess exited with code 0\nOutput:\n391', 'Chunk ID: printed-by-program\nnot metadata', '  原样保留\r\n']) assert.equal(commandOutput(text), text);
  assert.equal(commandOutput('Process exited with code 0\nOutput:\n'), '');
  assert.equal(commandOutput(null), '');
});

const terminal = (id, name, args, output) => ({ id, kind: 'tool', name, arguments: args, output, status: 'completed' });
test('terminal polls fold into their command without losing output, failures or original records', async () => {
  const root = terminal('entry-1', 'exec_command', { cmd: 'run' }, 'Process running with session ID 42\nOutput:\nhel');
  const empty = terminal('entry-2', 'write_stdin', { session_id: 42, chars: '' }, 'Process running with session ID 42\nOutput:\n');
  const output = terminal('entry-3', 'write_stdin', { session_id: 42, chars: '' }, 'Process exited with code 1\nOutput:\nlo\n');
  const original = [root, empty, output]; const before = JSON.stringify(original);
  const visible = coalesceTerminalEntries(original);
  assert.equal(visible.length, 1); assert.equal(visible[0].display_output, 'hello\n');
  assert.equal(visible[0].status, 'failed'); assert.equal(visible[0].exit_code, 1);
  assert.equal(JSON.stringify(original), before);
  assert.equal(await completeCommandOutput(visible[0], () => { throw Error('Unexpected fetch'); }), 'hello\n');
  assert.equal(coalesceTerminalEntries([empty]).length, 0, 'Even without a loaded command an empty successful poll adds no card');
  assert.equal(coalesceTerminalEntries([output]).length, 1, 'An orphan with real output or failure remains visible');
});

test('real terminal input remains separate and later polls attach after that input', async () => {
  const entries = [
    terminal('entry-0', 'exec_command', { cmd: 'interactive' }, 'Process running with session ID 7\nOutput:\nName?'),
    terminal('entry-1', 'write_stdin', { session_id: 7, chars: 'Ada\n' }, 'Process running with session ID 7\nOutput:\nHello '),
    terminal('entry-2', 'write_stdin', { session_id: 7, chars: '' }, 'Process exited with code 0\nOutput:\nAda!'),
  ];
  const visible = coalesceTerminalEntries(entries);
  assert.equal(visible.length, 2); assert.equal(visible[0].display_output, 'Name?'); assert.equal(visible[1].arguments.chars, 'Ada\n');
  assert.equal(visible[1].display_output, 'Hello Ada!'); assert.ok(visible.every(entry => entry.status === 'completed'));
  visible[1].output_parts[1].output_truncated = true;
  const requests = [];
  assert.equal(await completeCommandOutput(visible[1], async id => { requests.push(id); return 'Process exited with code 0\nOutput:\nAda! Full output'; }), 'Hello Ada! Full output');
  assert.deepEqual(requests, ['entry-2']);
});

test('unified model selection preserves defaults, independent reasoning and manual IDs', () => {
  const models = new ModelSelection({ models: ['first', 'second'], default_model: 'second', model_reasoning: { second: { reasoning_effort: 'max' } } });
  models.add('local/model:tag\nthird\nthird'); assert.deepEqual(models.models, ['first', 'second', 'local/model:tag', 'third']);
  assert.equal(models.defaultModel, 'second'); models.setDefault('third');
  models.remove('second'); assert.equal(models.defaultModel, 'third'); assert.deepEqual(models.snapshot().model_reasoning, {});
  models.remove('third'); assert.equal(models.defaultModel, 'first');
  const before = models.snapshot(); assert.throws(() => models.add('not a model'), /不包含空格/); assert.deepEqual(models.snapshot(), before);
  assert.throws(() => models.setDefault('missing'), /已添加/);
});

test('consecutive commands share one group without crossing messages or unrelated tools', () => {
  const first = terminal('entry-1', 'exec_command', { cmd: 'first' }, '1');
  const second = terminal('entry-2', 'functions.exec_command', { cmd: 'second' }, '2');
  const message = { id: 'entry-3', kind: 'assistant', text: 'Next step' };
  const third = terminal('entry-4', 'exec_command', { cmd: 'third' }, '3');
  const unrelated = terminal('entry-5', 'apply_patch', {}, 'done');
  const input = terminal('entry-6', 'write_stdin', { session_id: 42, chars: 'yes\n' }, 'yes');
  const last = terminal('entry-7', 'exec_command', { cmd: 'last' }, '7');
  const source = [first, second, message, third, unrelated, input, last]; const before = JSON.stringify(source);
  const grouped = groupCommandRuns(source);
  assert.equal(grouped.length, 5);
  assert.equal(grouped[0].kind, 'command_group'); assert.deepEqual(grouped[0].entries, [first, second]);
  assert.equal(grouped[1], message); assert.equal(grouped[2], third); assert.equal(grouped[3], unrelated);
  assert.deepEqual(grouped[4].entries, [input, last]);
  assert.equal(JSON.stringify(source), before);
});

test('command group disclosure survives refresh, explicit collapse and loading earlier commands', () => {
  const entries = [terminal('entry-1', 'exec_command', {}, ''), terminal('entry-2', 'exec_command', {}, '')];
  const group = groupCommandRuns(entries)[0];
  assert.equal(commandGroupOpen(group, new Set(), new Set()), false);
  assert.equal(commandGroupOpen(group, new Set(['entry-1']), new Set()), true, 'An inspected single command stays visible when another command arrives');
  assert.equal(commandGroupOpen(group, new Set(['entry-1']), new Set(['entry-1', 'entry-2'])), false, 'Closing the group wins over an expanded child');
  assert.equal(commandGroupOpen(group, new Set([group.id]), new Set()), true);
  const earlier = terminal('entry-0', 'exec_command', {}, ''); const expanded = groupCommandRuns([earlier, ...entries])[0];
  assert.equal(commandGroupOpen(expanded, new Set([group.id]), new Set(['entry-1', 'entry-2'])), true);
});
