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
import { managedConfig, tomlValue } from '../model-config.mjs';
import { applyReasoning, effectiveReasoning, normalizeReasoning } from '../reasoning.mjs';
import { documentFixture, eventually } from './dom-fixture.mjs';
import { createSelectMenus } from '../web/dropdown.js';

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

test('settings controller unifies models, preserves per-model drafts and tests only saved settings', async t => {
  const codec = {
    supported: true,
    protect: value => Buffer.from(value).toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString(),
  };
  const store = new ModelStore({ stateDir: fixture(), codec });
  const c = save(store, { models: ['a', 'b'], default_model: 'a', reasoning_effort: 'high', model_reasoning: { b: { reasoning_effort: 'max' } } }); store.setDefault(c.id, 'a');
  const v = await viewer(t, store); let probes = 0, saved = 0;
  v.gateway.probe = async (id, model) => { probes++; return { ok: true, tool_calling: true, message: `TEST ${model}` }; };
  let checkedInput;
  let testedDraft;
  v.gateway.probeDraft = async (input, id, model) => {
    testedDraft = { input, id, model };
    return { tool_calling: true, message: 'DRAFT TEST' };
  };
  v.gateway.discover = async input => {
    checkedInput = input;
    return { models: ['b', 'd'], capabilities: { d: { efforts: ['low', 'max'] } } };
  };
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  const document = documentFixture(readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8'));
  globalThis.document = document; globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/') ? v.url + url : url, options);
  t.after(() => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  let source = readFileSync(fileURLToPath(new URL('../web/settings.js', import.meta.url)), 'utf8');
  source = source
    .replace('./reasoning.js', new URL('../reasoning.mjs', import.meta.url).href)
    .replace('./model-selection.js', new URL('../web/model-selection.js', import.meta.url).href)
    .replace('./dropdown.js', new URL('../web/dropdown.js', import.meta.url).href)
    .replace('./api-endpoint.js', new URL('../api-endpoint.mjs', import.meta.url).href);
  const { createModelSettings } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const settings = createModelSettings({ toast() {}, onSaved() { saved++; } }); await settings.show();
  const $ = id => document.getElementById(id);
  const action = label => $('model-rows').querySelectorAll('button').find(button => button.getAttribute('aria-label') === label);
  assert.equal($('connection-editor').hidden, true, 'The list starts fully collapsed');
  assert.equal($('connection-editor-home').contains($('connection-editor')), true);
  await $(`connection-toggle-${c.id}`).dispatch('click');
  assert.equal($(`connection-row-${c.id}`).contains($('connection-editor')), true);
  assert.equal($(`connection-toggle-${c.id}`).getAttribute('aria-expanded'), 'true');
  const initialName = $('connection-name').value; $('connection-name').value = 'Unsaved name';
  await $(`connection-toggle-${c.id}`).dispatch('click'); assert.equal($('connection-editor').hidden, true);
  await $(`connection-toggle-${c.id}`).dispatch('click'); assert.equal($('connection-name').value, 'Unsaved name', 'Collapse and reopen retain the draft');
  $('connection-name').value = initialName;
  assert.equal($('connection-protocol-value').textContent, 'Chat Completions');
  assert.equal($('connection-endpoint-preview').textContent, '预览: http://127.0.0.1:1/v1/chat/completions');
  assert.equal($('stored-auth-field').hidden, false);
  assert.equal($('connection-api-key').required, false);
  assert.ok(!$('settings-load-error').textContent, $('settings-load-error').textContent);
  assert.ok(document.querySelectorAll('header')[0].contains($('new-connection')), 'Add connection belongs to the top bar');
  assert.equal($('new-connection').hidden, false); settings.hide(); assert.equal($('new-connection').hidden, true); await settings.show();
  assert.equal($('connection-kind-field').hidden, true);
  assert.equal($('reasoning-preview').open, false);
  assert.ok($('connections-list').querySelectorAll('select').every(select => $('connection-editor').contains(select)), 'Selection controls belong to the expanded form');
  await $('test-connection').dispatch('click'); await eventually(() => !$('save-connection').disabled); assert.equal(probes, 1);
  await action('编辑模型 b').dispatch('click');
  assert.equal($('model-dialog').open, true);
  assert.equal($('model-reasoning').value, 'max');
  await $('cancel-model-dialog').dispatch('click');
  await $('test-connection').dispatch('click'); await eventually(() => !$('save-connection').disabled); assert.equal(probes, 2, 'Viewing model settings is not an edit');
  $('connection-reasoning').value = 'provider:max';
  $('connection-thinking-budget').value = '2048'; await $('connection-thinking-budget').dispatch('input');
  assert.equal($('reasoning-preview').open, false); assert.equal($('reasoning-validation-error').hidden, false, 'Parameter errors remain visible while JSON preview is collapsed');
  $('connection-thinking-budget').value = ''; await $('connection-thinking-budget').dispatch('input'); assert.equal($('reasoning-validation-error').hidden, true);
  await $('test-connection').dispatch('click'); assert.equal(probes, 2); assert.match($('connection-test-result').textContent, /未保存/);
  const radio = $('model-rows').querySelectorAll('input').find(input => input.getAttribute('aria-label') === '将 b 设为默认模型'); radio.checked = true; await radio.dispatch('change');
  await $('add-model').dispatch('click');
  $('model-id-input').value = 'c';
  $('model-context-window').value = '32768';
  $('model-max-output').value = '4096';
  await $('test-model-draft').dispatch('click');
  assert.equal(testedDraft.model, 'c');
  assert.deepEqual(testedDraft.input.model_limits.c, { context_window: 32768, max_output_tokens: 4096 });
  assert.equal($('model-dialog-result').textContent, 'DRAFT TEST');
  assert.ok(!store.get(c.id).models.includes('c'));
  await $('model-dialog-form').dispatch('submit');
  await $('discover-models').dispatch('click'); await eventually(() => !$('save-connection').disabled);
  await action('添加模型 d').dispatch('click');
  assert.deepEqual($('model-effort-options').children.map(option => option.value), ['low', 'max']);
  await $('model-dialog-form').dispatch('submit');
  await $('connection-protocol-trigger').dispatch('click');
  await $('settings-select-menu').children.find(option => option.textContent === 'Responses API').dispatch('click');
  assert.equal($('connection-protocol').value, 'responses');
  $('connection-base-url').value = 'http://127.0.0.1:1/v1/chat/completions/';
  await $('connection-base-url').dispatch('input');
  assert.equal($('connection-endpoint-preview').textContent, '预览: http://127.0.0.1:1/v1/responses');
  await $('connection-form').dispatch('submit'); await eventually(() => saved === 1 && !$('save-connection').disabled);
  assert.equal(store.get(c.id).protocol, 'responses', 'Choosing from the styled menu reaches the saved configuration');
  assert.equal(store.get(c.id).base_url, 'http://127.0.0.1:1/v1');
  assert.equal(store.get(c.id).auth_mode, 'none');
  assert.deepEqual(store.get(c.id).models, ['a', 'b', 'c', 'd']); assert.equal(store.get(c.id).default_model, 'b');
  assert.deepEqual(store.get(c.id).model_limits.c, { context_window: 32768, max_output_tokens: 4096 });
  assert.equal(store.get(c.id).model_reasoning.b.reasoning_effort, 'max'); assert.equal(probes, 2, 'Saving does not run inference');
  await $('test-connection').dispatch('click'); await eventually(() => !$('save-connection').disabled); assert.equal(probes, 3); assert.match($('connection-test-result').textContent, /TEST b/);
  await action('删除模型 b').dispatch('click');
  await action('编辑模型 d').dispatch('click');
  assert.equal($('model-thinking-format-trigger').disabled, true);
  $('model-reasoning-override').checked = true;
  await $('model-reasoning-override').dispatch('change');
  assert.equal($('model-thinking-format-trigger').disabled, false);
  await $('model-dialog-form').dispatch('submit');
  await $('connection-form').dispatch('submit'); await eventually(() => saved === 2 && !$('save-connection').disabled);
  assert.equal(store.get(c.id).default_model, 'a'); assert.equal(store.get(c.id).model_reasoning.b, undefined); assert.deepEqual(store.get(c.id).model_reasoning.d, {});
  await $('new-connection').dispatch('click');
  assert.equal($('connection-kind-field').hidden, false); assert.equal($('connection-kind').disabled, false);
  const profile = store.publicConfig().connections.find(connection => connection.kind === 'profile');
  await $(`connection-toggle-${profile.id}`).dispatch('click');
  assert.equal($('connection-kind-field').hidden, true);
  assert.equal($('connection-profile').placeholder, `文件位于 ${join(store.stateDir, 'codex')}，例如 deepseek.config.toml 填写 deepseek`);
  assert.equal($('connection-kind-value').textContent, '已有 Codex profile');
  assert.equal($('connection-protocol-trigger').disabled, true);
  assert.equal($(`connection-toggle-${c.id}`).getAttribute('aria-expanded'), 'false');
  assert.equal($(`connection-row-${profile.id}`).contains($('connection-editor')), true);
  await $('new-connection').dispatch('click'); $('connection-name').value = 'Created from row';
  $('connection-base-url').value = 'http://127.0.0.1:11434/v1';
  await $('add-model').dispatch('click');
  $('model-id-input').value = 'new-model';
  await $('model-dialog-form').dispatch('submit');
  $('connection-api-key').value = 'fixture-key';
  await $('check-api-service').dispatch('click');
  await eventually(() => !$('check-api-service').disabled);
  assert.equal(checkedInput.api_key, 'fixture-key');
  await $('show-api-key').dispatch('click');
  assert.equal($('connection-api-key').type, 'text');
  await $('connection-toggle-new').dispatch('click'); assert.equal($('connection-row-new'), undefined);
  await $('new-connection').dispatch('click'); assert.equal($('connection-name').value, 'Created from row');
  assert.equal($('connection-api-key').type, 'password');
  assert.equal($('connection-api-key').value, 'fixture-key', 'Hiding a new key preserves the draft');
  await $('connection-form').dispatch('submit'); await eventually(() => saved === 3 && !$('save-connection').disabled);
  const created = store.read().connections.find(connection => connection.name === 'Created from row'); assert.ok(created);
  assert.equal(created.auth_mode, 'stored', 'Typing a key in the main form enables saved-key authentication');
  assert.equal($('connection-api-key').value, '');
  assert.equal($('connection-api-key').required, false, 'Editing an existing saved key may leave the field blank');
  const revealUrl = `${v.url}/api/config/connections/${created.id}/reveal-key`;
  const revealOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await originalFetch(revealUrl)).status, 404);
  assert.equal((await originalFetch(revealUrl, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await originalFetch(revealUrl, {
    ...revealOptions, headers: { ...revealOptions.headers, Origin: 'https://foreign.test' },
  })).status, 403);
  assert.equal((await originalFetch(`${v.url}/api/config/connections/${c.id}/reveal-key`, revealOptions)).status, 404);
  assert.ok(!(await (await originalFetch(v.url + '/api/config')).text()).includes('fixture-key'));
  await $('show-api-key').dispatch('click');
  assert.equal($('connection-api-key').value, 'fixture-key');
  assert.equal($('connection-api-key').type, 'text');
  await $('test-connection').dispatch('click');
  await eventually(() => !$('save-connection').disabled);
  assert.equal(probes, 4, 'Revealing an existing key does not mark the form dirty');
  await $('show-api-key').dispatch('click');
  assert.equal($('connection-api-key').value, '');
  assert.equal($('connection-api-key').type, 'password');
  const pendingReveal = $('show-api-key').dispatch('click');
  await $(`connection-toggle-${created.id}`).dispatch('click');
  await pendingReveal;
  assert.equal($('connection-api-key').value, '', 'A pending reveal cannot repopulate a collapsed editor');
  await $(`connection-toggle-${created.id}`).dispatch('click');
  await $('show-api-key').dispatch('click');
  assert.equal($('connection-api-key').value, 'fixture-key');
  await $(`connection-toggle-${created.id}`).dispatch('click');
  assert.equal($('connection-api-key').value, '', 'Closing an expanded editor clears the revealed key');
  await $(`connection-toggle-${created.id}`).dispatch('click');
  assert.equal($('connection-row-new'), undefined); assert.equal($(`connection-row-${created.id}`).contains($('connection-editor')), true);
  await $('remove-connection').dispatch('click'); await $('confirm-remove-connection').dispatch('click');
  assert.equal(store.read().connections.some(connection => connection.id === created.id), false); assert.equal($('connection-editor').hidden, true);
  assert.equal($('connections-list').querySelectorAll('form').length, 0, 'The collapsed list contains no visible editor');
  assert.equal(document.querySelectorAll('form').filter(form => form.id === 'connection-form').length, 1, 'Moving the form never duplicates its controls');
});

test('select menus commit native values, skip disabled choices, cancel and stay within the viewport', async () => {
  const document = documentFixture('<body><label for="mode">Mode</label><select id="mode"><option value="a">Alpha</option><option value="b" disabled>Beta</option><option value="c">Charlie</option></select><fieldset disabled><label for="other">Other</label><select id="other"><option value="x">X</option></select></fieldset></body>');
  const controls = createSelectMenus(document), $ = id => document.getElementById(id);
  const button = $('mode-trigger'), menu = $('settings-select-menu'); let inputs = 0, changes = 0;
  $('mode').addEventListener('input', () => inputs++); $('mode').addEventListener('change', () => changes++);
  assert.equal($('mode-value').textContent, 'Alpha'); assert.equal($('other-trigger').disabled, true);
  await button.dispatch('click'); assert.equal(menu.hidden, false); assert.equal(button.getAttribute('aria-expanded'), 'true');
  await menu.children[1].dispatch('click'); assert.equal($('mode').value, 'a'); assert.equal(menu.hidden, false);
  await button.dispatch('keydown', { key: 'ArrowDown' }); await button.dispatch('keydown', { key: 'Enter' });
  assert.equal($('mode').value, 'c'); assert.equal($('mode-value').textContent, 'Charlie'); assert.equal(inputs, 1); assert.equal(changes, 1); assert.equal(menu.hidden, true);
  await button.dispatch('keydown', { key: 'Home' }); await button.dispatch('keydown', { key: 'Escape' }); assert.equal($('mode').value, 'c');
  await button.dispatch('click'); await button.dispatch('keydown', { key: 'a' }); await button.dispatch('keydown', { key: 'Enter' }); assert.equal($('mode').value, 'a');
  await button.dispatch('click'); await button.dispatch('keydown', { key: 'Tab' }); assert.equal(menu.hidden, true);
  $('mode').value = 'c'; controls.refresh(); assert.equal($('mode-value').textContent, 'Charlie');
  button.rect = { left: 910, top: 730, bottom: 769, width: 300, height: 39 };
  await button.dispatch('click'); assert.ok(parseFloat(menu.style.top) < button.rect.top); assert.ok(parseFloat(menu.style.left) + parseFloat(menu.style.width) <= 1016);
  await document.dispatch('scroll', { target: menu }); assert.equal(menu.hidden, false);
  await document.dispatch('scroll', { target: document.body }); assert.equal(menu.hidden, true);
  await button.dispatch('click'); await document.dispatch('pointerdown', { target: document.body }); assert.equal(menu.hidden, true);
  await button.dispatch('click'); await document.defaultView.dispatch('resize'); assert.equal(menu.hidden, true);
  await button.dispatch('click'); $('mode').disabled = true; controls.refresh(); assert.equal(menu.hidden, true); assert.equal(button.disabled, true);
  assert.equal($('mode').getAttribute('aria-hidden'), 'true'); assert.equal(button.getAttribute('aria-activedescendant'), null);
});

test('manual effort values and complete per-model overrides round-trip without changing legacy defaults', () => {
  const store = new ModelStore({ stateDir: fixture() });
  const c = save(store, { models: ['a', 'b', 'c'], default_model: 'a', reasoning_effort: 'high', model_reasoning: { a: { reasoning_effort: 'provider:max' }, b: {} } });
  const reopened = new ModelStore({ stateDir: store.stateDir });
  const persisted = reopened.get(c.id);
  assert.equal(effectiveReasoning(persisted, 'a').reasoning_effort, 'provider:max');
  assert.deepEqual(effectiveReasoning(persisted, 'b'), {});
  assert.equal(effectiveReasoning(persisted, 'c').reasoning_effort, 'high');
  assert.deepEqual(reopened.publicConfig().connections.at(-1).model_reasoning, c.model_reasoning);
  for (const effort of ['none', 'minimal', 'xhigh', 'max', 'ultra']) assert.equal(normalizeReasoning({ reasoning_effort: effort }).reasoning_effort, effort);
  const before = readFileSync(store.path, 'utf8');
  assert.throws(() => store.save({ ...c, model_reasoning: { missing: {} } }, c.id), /当前模型列表/);
  assert.throws(() => store.save({ ...c, thinking_budget: 2048 }, c.id), /通用预算/);
  assert.throws(() => store.save({ ...c, thinking_mode: 'disabled' }, c.id), /关闭思考/);
  assert.throws(() => normalizeReasoning({ thinking_format: 'thinking', thinking_budget: true }), /整数/);
  assert.throws(() => normalizeReasoning({ thinking_format: 'thinking', thinking_budget: ' ' }), /整数/);
  assert.equal(readFileSync(store.path, 'utf8'), before);
});

test('both protocols apply selected-model efforts and explicit blanks omit inherited CLI effort', async t => {
  for (const protocol of ['responses', 'chat_completions']) {
    let captured;
    const endpoint = await upstream(t, async (req, res) => {
      captured = await readJSON(req);
      if (protocol === 'responses') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"done","status":"completed","output":[]}}\n\n');
      } else stream(res, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]);
    });
    const store = new ModelStore({ stateDir: fixture() });
    const c = save(store, { protocol, base_url: endpoint, models: ['a', 'b', 'c'], default_model: 'a', reasoning_effort: 'high', model_reasoning: { a: { reasoning_effort: 'provider:max' }, b: {} } }); const v = await viewer(t, store);
    for (const [model, expected] of [['a', 'provider:max'], ['b', undefined], ['c', 'high']]) {
      const result = await inference(v, store, c, { model, input: 'hello', reasoning: { effort: 'ultra' } }); assert.equal(result.status, 200);
      assert.equal(protocol === 'responses' ? captured.reasoning?.effort : captured.reasoning_effort, expected);
    }
    assert.deepEqual(applyReasoning({ model: 'b', reasoning: { effort: 'ultra' } }, store.get(c.id)), { model: 'b' });
  }
});

test('thinking modes, budgets and compatible reasoning objects use distinct fields', async t => {
  let captured;
  const endpoint = await upstream(t, async (req, res) => { captured = await readJSON(req); stream(res, [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]); });
  const store = new ModelStore({ stateDir: fixture() });
  const c = save(store, { base_url: endpoint, thinking_format: 'thinking', thinking_mode: 'adaptive', thinking_budget: 8192, reasoning_effort: 'high' }); const v = await viewer(t, store);
  await inference(v, store, c, { model: c.default_model, input: 'hello' });
  assert.deepEqual(captured.thinking, { type: 'adaptive', budget_tokens: 8192 }); assert.equal(captured.reasoning_effort, 'high');
  await v.gateway.probe(c.id);
  assert.ok(captured.max_tokens > captured.thinking.budget_tokens, 'Probe output cap reserves space beyond the configured thinking budget');
  store.save({ ...c, thinking_format: 'reasoning', thinking_mode: 'enabled', thinking_budget: 2048, reasoning_effort: '' }, c.id);
  await inference(v, store, c, { model: c.default_model, input: 'hello' });
  assert.deepEqual(captured.reasoning, { enabled: true, max_tokens: 2048 }); assert.equal(captured.thinking, undefined); assert.equal(captured.reasoning_effort, undefined);
  const disabled = normalizeReasoning({ thinking_mode: 'disabled' });
  assert.deepEqual(applyReasoning({ model: 'x' }, disabled, 'responses').reasoning, { effort: 'none' });
  assert.equal(applyReasoning({ model: 'x' }, disabled, 'chat_completions').reasoning_effort, 'none');
  assert.throws(() => normalizeReasoning({ thinking_mode: 'adaptive' }), /thinking 对象/);
});

test('model discovery exposes effort capabilities as hints and does not change saved parameters', async t => {
  const endpoint = await upstream(t, (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' }, secret: 'must-not-appear' }] })); });
  const store = new ModelStore({ stateDir: fixture() }); const c = save(store, { base_url: endpoint }); const v = await viewer(t, store);
  const before = readFileSync(store.path, 'utf8'); const result = await v.gateway.discover(c, c.id);
  assert.deepEqual(result.capabilities['test-model'], { efforts: ['low', 'high', 'max'], default_effort: 'high' });
  assert.ok(!JSON.stringify(result).includes('must-not-appear')); assert.equal(readFileSync(store.path, 'utf8'), before);
});

test('managed CLI does not interpret upstream effort values as client execution modes', async t => {
  const stateDir = fixture(); const store = new ModelStore({ stateDir });
  const c = save(store, { reasoning_effort: 'provider:max', models: ['test-model', 'alternate'], context_window: 32768, model_limits: { alternate: { context_window: 65536 } } });
  store.setDefault(c.id, c.default_model);
  const manager = new JobManager({ stateDir, modelStore: store, env: { ...process.env, CODEX_SUBAGENT_DEPTH: '0' }, codexBin: process.execPath, codexArgs: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))] }); t.after(() => manager.shutdown());
  const result = await manager.call({ prompt: JSON.stringify({ reportArgs: true }), model: 'alternate' });
  const argv = JSON.parse(result.result.text).argv;
  assert.ok(!argv.some(arg => arg.includes('model_reasoning_effort') || arg.includes('provider:max')));
  assert.ok(argv.includes('model_context_window=65536'));
});

test('users can reference existing profiles and preserve legacy API connection routing on edits', async t => {
  const stateDir = fixture(); const store = new ModelStore({ stateDir });
  const c = save(store, { kind: 'profile', profile: 'my-route' });
  store.setDefault(c.id, c.default_model);
  const manager = new JobManager({ stateDir, modelStore: store, env: { ...process.env, CODEX_SUBAGENT_DEPTH: '0' }, codexBin: process.execPath, codexArgs: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))] });
  t.after(() => manager.shutdown());
  const result = await manager.call({ prompt: JSON.stringify({ reportArgs: true }) });
  const argv = JSON.parse(result.result.text).argv;
  assert.equal(argv[argv.indexOf('--profile') + 1], 'my-route');
  assert.ok(!argv.some(a => a.includes('/inference/')));
  assert.throws(() => save(store, { kind: 'profile', profile: '../bad' }), /profile/);
  const legacy = save(store, { kind: 'router' });
  const before = store.fingerprint(store.get(legacy.id));
  store.save({ ...legacy, name: 'Renamed' }, legacy.id);
  assert.equal(store.fingerprint(store.get(legacy.id)), before);
});

test('profile export reuses runtime provider configuration without exporting secrets or writing Codex settings', async t => {
  const secret = 'export-private-' + randomUUID();
  const store = new ModelStore({ stateDir: fixture(), env: { EXPORT_SECRET: secret } });
  const c = save(store, { auth_mode: 'env', api_key_env: 'EXPORT_SECRET', context_window: 32768, reasoning_effort: 'low' });
  const before = readFileSync(store.path, 'utf8');
  const v = await viewer(t, store);
  const browserModule = await fetch(v.url + '/reasoning.js');
  assert.equal(browserModule.status, 200);
  assert.match(browserModule.headers.get('content-type'), /javascript/);
  assert.ok((await browserModule.text()).includes('export function applyReasoning'));
  const route = `${v.url}/api/config/connections/${c.id}/export-profile`;
  assert.equal((await fetch(route, { method: 'POST', headers: { Origin: 'https://foreign.test' } })).status, 403);
  const response = await fetch(route, { method: 'POST' }); assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.filename, `exo-${c.id}.config.toml`);
  assert.ok(data.target.endsWith(data.filename));
  assert.ok(data.content.includes(`model = "test-model"`));
  for (const [key, value] of Object.entries(managedConfig(c, { baseUrl: v.url, fingerprint: store.fingerprint(store.get(c.id)) }))) assert.ok(data.content.includes(`${key} = ${tomlValue(value)}`));
  assert.ok(!JSON.stringify(data).includes(secret));
  assert.ok(!JSON.stringify(data).includes(store.gatewayToken()));
  assert.ok(data.launch.includes(store.tokenPath));
  assert.equal(readFileSync(store.path, 'utf8'), before);
  assert.equal((await fetch(`${v.url}/api/config/connections/current-profile/export-profile`, { method: 'POST' })).status, 400);
  store.save({ ...c, enabled: false }, c.id);
  assert.equal((await fetch(route, { method: 'POST' })).status, 400);
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

test('connection failures identify the upstream network error and disabled connections are explicit', async t => {
  const server = http.createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  const store = new ModelStore({ stateDir: fixture() });
  const c = save(store, { protocol: 'responses', base_url: `http://127.0.0.1:${port}/v1` });
  const v = await viewer(t, store);
  const result = await inference(v, store, c, { model: 'test-model', input: 'hello' });
  assert.equal(result.status, 502);
  assert.match(result.error.error.message, /无法连接模型服务/);
  assert.match(result.error.error.message, /ECONNREFUSED/);
  await assert.rejects(v.gateway.discover(c, c.id), /ECONNREFUSED/);
  store.save({ ...c, enabled: false }, c.id);
  await assert.rejects(v.gateway.probe(c.id), /连接已停用/);
});

test('connection probes allow automatic tools in thinking mode and only confirm observed tool calls', async t => {
  for (const protocol of ['responses', 'chat_completions']) {
    let observed, emitTool = true;
    const endpoint = await upstream(t, async (req, res) => {
      const body = await readJSON(req); observed = body;
      if (body.tool_choice !== 'auto') { res.writeHead(400); res.end('{"error":{"message":"Thinking mode does not support this tool_choice"}}'); return; }
      if (protocol === 'responses') {
        const output = emitTool ? [{ type: 'function_call', name: 'subagent_connection_probe', arguments: '{"ok":true}' }] : [];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }) + '\n\n');
      } else {
        const delta = emitTool ? { tool_calls: [{ index: 0, id: 'probe', function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }] } : { content: 'Hello' };
        stream(res, [{ choices: [{ delta, finish_reason: emitTool ? 'tool_calls' : 'stop' }] }]);
      }
    });
    const store = new ModelStore({ stateDir: fixture() }); const c = save(store, { protocol, base_url: endpoint, reasoning_effort: 'high' }); const v = await viewer(t, store);
    assert.equal((await v.gateway.probe(c.id)).tool_calling, true);
    assert.equal(protocol === 'responses' ? observed.reasoning?.effort : observed.reasoning_effort, 'high');
    const before = readFileSync(store.path, 'utf8');
    const draft = { ...c, models: ['draft-model'], default_model: 'draft-model', model_limits: { 'draft-model': { max_output_tokens: 128 } } };
    const response = await fetch(v.url + '/api/config/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: draft, connection_id: c.id, model: 'draft-model' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tool_calling, true);
    assert.equal(observed.model, 'draft-model');
    assert.equal(protocol === 'responses' ? observed.max_output_tokens : observed.max_tokens, 128);
    assert.equal(readFileSync(store.path, 'utf8'), before);
    emitTool = false;
    const unconfirmed = await v.gateway.probe(c.id);
    assert.equal(unconfirmed.tool_calling, false);
    assert.match(unconfirmed.message, /尚未确认/);
  }
});
