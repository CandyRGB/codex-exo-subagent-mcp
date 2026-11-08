import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelStore, WindowsSecretCodec } from '../model-store.mjs';
import { JobManager } from '../runtime.mjs';
import { createViewer } from '../viewer.mjs';
import { readJSON, sseJSON, responsesToChat } from '../model-gateway.mjs';

function fixture() { const stateDir = fileURLToPath(new URL(`../.test-runs/models-${randomUUID()}/`, import.meta.url)); mkdirSync(stateDir, { recursive: true }); return stateDir; }
function save(store, extra = {}) {
  const config = store.save({ name: '测试 API', kind: 'api', protocol: 'chat_completions', base_url: 'http://127.0.0.1:1/v1', auth_mode: 'none', models: ['test-model'], default_model: 'test-model', ...extra });
  return config.connections.at(-1);
}
async function upstream(t, handler) {
  const server = http.createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message); }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function stream(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.end('data: [DONE]\n\n');
}
async function viewer(t, store) {
  const v = await createViewer({ stateDir: store.stateDir, codexHome: join(store.stateDir, 'codex'), port: 0, modelStore: store });
  t.after(() => v.close()); return v;
}
async function inference(v, store, c, body) {
  const r = await fetch(`${v.url}/inference/${c.id}/v1/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.gatewayToken()}`, 'X-Subagent-Route-Hash': store.fingerprint(store.get(c.id)) }, body: JSON.stringify(body) });
  if (!r.ok) return { status: r.status, error: await r.json() };
  const events = []; for await (const e of sseJSON(r.body)) events.push(e);
  return { status: r.status, events, final: events.find(e => e.type === 'response.completed')?.response };
}

test('configuration preserves the current profile and supports explicit defaults and model lists', () => {
  const store = new ModelStore({ stateDir: fixture() });
  assert.equal(store.select({}).profile, 'workbuddy');
  const c = save(store, { models: ['a', 'b'], default_model: 'b' });
  store.setDefault(c.id, 'a'); assert.equal(store.select({}).model, 'a');
  assert.equal(store.select({ model: 'custom-alias' }).model, 'custom-alias');
  assert.equal(store.describe(c.id).connections[0].models.length, 2);
  assert.throws(() => store.remove(c.id), /默认/);
  store.setDefault('current-profile', 'deepseek-v4.1-flash'); store.remove(c.id);
  assert.equal(store.read().connections.length, 1);
});

test('invalid endpoints and authentication are rejected without changing persisted settings', () => {
  const store = new ModelStore({ stateDir: fixture() }); const initial = readFileSync(store.path, 'utf8');
  for (const base_url of ['file:///etc/passwd', 'https://user:secret@example.test/v1', 'https://example.test/v1?api_key=secret']) assert.throws(() => save(store, { base_url }), /API 地址/);
  assert.throws(() => save(store, { auth_mode: 'env', api_key_env: 'INVALID-NAME' }), /环境变量/);
  assert.throws(() => save(store, { auth_header: 'Host' }), /请求头/);
  assert.equal(readFileSync(store.path, 'utf8'), initial);
});

test('Windows user encryption stores no plaintext API key and blank edits preserve the secret', { skip: process.platform !== 'win32' }, () => {
  const stateDir = fixture(); const store = new ModelStore({ stateDir }); const key = 'test-private-' + randomUUID();
  const c = save(store, { auth_mode: 'stored', api_key: key });
  assert.equal(store.secret(store.get(c.id)), key);
  assert.ok(!readFileSync(store.secretsPath, 'utf8').includes(key));
  assert.ok(!readFileSync(store.path, 'utf8').includes(key));
  assert.ok(!JSON.stringify(store.publicConfig()).includes(key));
  store.save({ ...c, api_key: '' }, c.id);
  const reopened = new ModelStore({ stateDir, codec: new WindowsSecretCodec() });
  assert.equal(reopened.secret(reopened.get(c.id)), key);
});

test('runtime picks live settings; resumes keep their connection and reject changed routes', async t => {
  const stateDir = fixture(); const env = { ...process.env, CODEX_SUBAGENT_DEPTH: '0' }; const store = new ModelStore({ stateDir, env });
  const manager = new JobManager({ stateDir, env, modelStore: store, codexBin: process.execPath, codexArgs: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))] }); t.after(() => manager.shutdown());
  const c = save(store); store.setDefault(c.id, c.default_model);
  const result = await manager.call({ prompt: JSON.stringify({ reportArgs: true }) });
  assert.equal(result.connection_id, c.id); assert.equal(result.model, 'test-model');
  const argv = JSON.parse(result.result.text).argv;
  assert.ok(argv.some(arg => arg.includes(`/inference/${c.id}/v1`))); assert.ok(!argv.includes('--profile'));
  assert.ok(!argv.includes(store.gatewayToken()));
  store.setDefault('current-profile', 'deepseek-v4.1-flash');
  const continued = await manager.call({ action: 'resume', job_id: result.job_id, prompt: JSON.stringify({ text: 'RESUMED' }) });
  const done = await manager.wait(continued.job_id, 5);
  assert.equal(done.connection_id, c.id); assert.equal(done.session_id, result.session_id);
  store.save({ ...c, base_url: 'http://127.0.0.1:2/v1' }, c.id);
  await assert.rejects(manager.call({ action: 'resume', job_id: result.job_id, prompt: '{}' }), /改变/);
});

test('Chat conversion preserves replayed messages, namespaces, tool results and structured output', () => {
  const body = { model: 'x', instructions: 'system', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }] }], input: [{ role: 'developer', content: [{ type: 'input_text', text: 'more system' }] }, { role: 'user', content: 'run' }, { type: 'function_call', namespace: 'functions', name: 'exec_command', call_id: 'call1', arguments: '{"cmd":"pwd"}' }, { type: 'function_call_output', call_id: 'call1', output: 'folder' }], text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } } };
  const { request } = responsesToChat(body);
  assert.equal(request.messages[0].content, 'system\n\nmore system');
  assert.equal(request.messages.at(-1).role, 'tool'); assert.equal(request.messages.at(-1).tool_call_id, 'call1');
  assert.equal(request.messages[2].tool_calls[0].function.name, request.tools[0].function.name);
  assert.equal(request.response_format.type, 'json_schema');
});

test('Chat SSE text, fragmented arguments, custom tools, usage and terminal completion are translated', async t => {
  let captured;
  const endpoint = await upstream(t, async (req, res) => {
    captured = await readJSON(req);
    const tool = captured.tools[0].function.name;
    stream(res, [
      { choices: [{ delta: { content: '准备' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_custom', function: { name: tool, arguments: '{"input":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"raw patch"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 14, completion_tokens: 9, total_tokens: 23 } },
    ]);
  });
  const store = new ModelStore({ stateDir: fixture() }); const c = save(store, { base_url: endpoint + '/v1' }); const v = await viewer(t, store);
  const result = await inference(v, store, c, { model: 'test-model', stream: true, input: 'do it', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch.' }] }] });
  assert.equal(result.status, 200); assert.equal(result.final.status, 'completed');
  assert.equal(result.final.output[0].content[0].text, '准备');
  assert.equal(result.final.output[1].type, 'custom_tool_call'); assert.equal(result.final.output[1].namespace, 'functions'); assert.equal(result.final.output[1].input, 'raw patch');
  assert.equal(result.final.usage.input_tokens, 14);
  assert.equal(result.events.filter(e => e.type === 'response.completed').length, 1);
});

test('gateway can discover models, probe tools, preserve previous responses and retry unsupported stream_options', async t => {
  const requests = []; let rejected = false;
  const endpoint = await upstream(t, async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] })); return; }
    const body = await readJSON(req); requests.push(body);
    if (body.stream_options && !rejected) { rejected = true; res.writeHead(400); res.end('stream_options is unsupported'); return; }
    if (body.tools?.length) stream(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }] }]);
    else stream(res, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]);
  });
  const store = new ModelStore({ stateDir: fixture() }); const c = save(store, { base_url: endpoint + '/v1' }); const v = await viewer(t, store);
  assert.deepEqual((await v.gateway.discover(c, c.id)).models, ['a', 'b']);
  const probe = await v.gateway.probe(c.id); assert.equal(probe.tool_calling, true); assert.ok(requests.some(r => !r.stream_options));
  const first = await inference(v, store, c, { model: 'test-model', input: 'first' });
  const next = await inference(v, store, c, { model: 'test-model', previous_response_id: first.final.id, input: 'second' });
  assert.equal(next.final.output[0].content[0].text, 'OK');
  assert.ok(requests.at(-1).messages.some(m => m.role === 'assistant' && m.content === 'OK'));
});

test('Responses proxy authenticates locally, injects upstream credentials and redacts errors', async t => {
  const secret = 'not-for-browser-' + randomUUID(); let header;
  const endpoint = await upstream(t, async (req, res) => {
    header = req.headers['x-api-key'];
    const body = await readJSON(req);
    if (body.fail) { res.writeHead(401); res.end('invalid credential ' + header); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('event: response.completed\ndata: '+JSON.stringify({ type: 'response.completed', response: { id: 'native', status: 'completed', output: [] } })+'\n\n');
  });
  const store = new ModelStore({ stateDir: fixture(), env: { TEST_MODEL_SECRET: secret } });
  const c = save(store, { protocol: 'responses', base_url: endpoint + '/v1', auth_mode: 'env', api_key_env: 'TEST_MODEL_SECRET', auth_header: 'X-API-Key' }); const v = await viewer(t, store);
  const unauthorized = await fetch(`${v.url}/inference/${c.id}/v1/responses`, { method: 'POST', body: '{}' }); assert.equal(unauthorized.status, 401);
  const result = await inference(v, store, c, { model: 'test-model', input: 'hello' }); assert.equal(result.final.id, 'native'); assert.equal(header, secret);
  const failed = await inference(v, store, c, { fail: true }); assert.equal(failed.status, 401); assert.ok(!JSON.stringify(failed).includes(secret));
  const config = await (await fetch(v.url + '/api/config')).json(); assert.ok(!JSON.stringify(config).includes(secret));
});

test('configuration HTTP CRUD supports saved connections and rejects foreign-origin mutation', async t => {
  const store = new ModelStore({ stateDir: fixture() }); const v = await viewer(t, store);
  const draft = { name: 'Local', kind: 'local', protocol: 'chat_completions', base_url: 'http://127.0.0.1:11434/v1', auth_mode: 'none', models: ['qwen-coder'] };
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) };
  assert.equal((await fetch(v.url + '/api/config/connections', { ...options, headers: { ...options.headers, Origin: 'https://foreign.test' } })).status, 403);
  const saved = await (await fetch(v.url + '/api/config/connections', options)).json(); const id = saved.connections.at(-1).id;
  assert.equal((await fetch(v.url + '/api/config/default', { method: 'PATCH', headers: options.headers, body: JSON.stringify({ connection_id: id, model: 'qwen-coder' }) })).status, 200);
  assert.equal(store.select({}).model, 'qwen-coder');
  assert.equal((await fetch(v.url + '/api/config/connections/' + id, { method: 'DELETE' })).status, 400);
});

test('model discovery honors no-auth selection even if a hidden input still contains an API key', async t => {
  let authorization;
  const endpoint = await upstream(t, (req, res) => { authorization = req.headers.authorization; res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"model"}]}'); });
  const store = new ModelStore({ stateDir: fixture() }); const v = await viewer(t, store);
  const result = await v.gateway.discover({ name: 'No auth', kind: 'local', protocol: 'chat_completions', base_url: endpoint, auth_mode: 'none', api_key: 'must-not-be-sent', models: [] });
  assert.equal(authorization, undefined); assert.deepEqual(result.models, ['model']);
});
