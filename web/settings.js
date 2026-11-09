import { applyReasoning, normalizeReasoning } from './reasoning.js';
import { ModelSelection } from './model-selection.js';
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const kinds = { profile: '已有 Codex profile', local: '模型 API 连接', api: '模型 API 连接', router: '模型 API 连接' };
const protocols = { profile: 'Codex profile', responses: 'Responses', chat_completions: 'Chat Completions' };

export function createModelSettings({ toast, onSaved = () => {} }) {
  let config = null, editingId = null, pendingDelete = null, busy = false, exported = null;
  let reasoningDefaults = {}, modelReasoning = Object.create(null), reasoningScope = '', discoveredCapabilities = {};
  let selection = new ModelSelection(), discoveredModels = [], savedSignature = '';
  const modelsOf = () => selection.models;
  async function api(path, options = {}) {
    const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || '模型配置操作失败'); return data;
  }
  const payload = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  function result(message = '', ok = true) { const target = $('connection-test-result'); target.hidden = !message; target.textContent = message; target.className = `connection-test-result${ok ? ' success' : ' error'}`; }
  function busyState(value) {
    busy = value;
    for (const id of ['save-connection', 'test-connection', 'discover-models', 'new-connection', 'export-connection', 'add-model']) $(id).disabled = value;
    $('test-connection').disabled = value || !editingId;
    $('save-connection').textContent = value ? '正在处理…' : '保存连接';
  }
  function renderModels() {
    const rows = document.createDocumentFragment();
    const candidates = discoveredModels.filter(model => !modelsOf().includes(model));
    for (const model of [...modelsOf(), ...candidates]) {
      const added = modelsOf().includes(model); const row = el('tr', reasoningScope === model ? 'model-row-selected' : '');
      const name = el('td'); name.append(el('code', '', model)); if (!added) name.append(el('span', 'model-candidate', '未添加'));
      const chosen = el('td');
      if (added) {
        const radio = el('input'); radio.type = 'radio'; radio.name = 'default-model'; radio.checked = model === selection.defaultModel;
        radio.setAttribute('aria-label', `将 ${model} 设为默认模型`);
        radio.addEventListener('change', () => { if (busy) return; selection.setDefault(model); renderModels(); previewReasoning(); }); const hit = el('label', 'model-default-hit'); hit.append(radio); chosen.append(hit);
      }
      const actions = el('td'); const group = el('div', 'model-row-actions');
      if (added) {
        if ($('connection-kind').value !== 'profile') {
          const thinking = el('button', 'text-button', '思考设置'); thinking.type = 'button'; thinking.setAttribute('aria-label', `编辑 ${model} 的思考设置`);
          thinking.addEventListener('click', () => { if (busy) return; saveReasoningScope(); reasoningScope = model; loadReasoningScope(); renderModels(); $('connection-advanced').open = true; $('reasoning-scope-label').scrollIntoView({ block: 'nearest' }); }); group.append(thinking);
        }
        const remove = el('button', 'model-remove', '移除'); remove.type = 'button'; remove.setAttribute('aria-label', `移除模型 ${model}`);
        remove.addEventListener('click', () => { if (busy) return; saveReasoningScope(); selection.remove(model); if (reasoningScope === model) reasoningScope = ''; loadReasoningScope(); renderModels(); }); group.append(remove);
      } else {
        const add = el('button', 'text-button', '添加'); add.type = 'button'; add.setAttribute('aria-label', `添加模型 ${model}`);
        add.addEventListener('click', () => { if (busy) return; try { selection.add(model); renderModels(); previewReasoning(); } catch (error) { result(error.message, false); } }); group.append(add);
      }
      actions.append(group); row.append(name, chosen, actions); rows.append(row);
    }
    if (!modelsOf().length && !candidates.length) { const row = el('tr'); const cell = el('td', 'empty-models', '填写模型 ID，或获取模型列表后添加。'); cell.colSpan = 3; row.append(cell); rows.append(row); }
    $('model-rows').replaceChildren(rows);
  }
  function commitModelInput() {
    const value = $('model-id-input').value.trim(); if (!value) return;
    selection.add(value); $('model-id-input').value = ''; renderModels(); previewReasoning();
  }
  function readReasoningFields() {
    return { reasoning_effort: $('connection-reasoning').value.trim(), thinking_format: $('connection-thinking-format').value,
      thinking_mode: $('connection-thinking-mode').value.trim(), thinking_budget: $('connection-thinking-budget').value };
  }
  function saveReasoningScope() {
    if (!reasoningScope) reasoningDefaults = readReasoningFields();
    else if ($('reasoning-model-override').checked) modelReasoning[reasoningScope] = readReasoningFields();
    else delete modelReasoning[reasoningScope];
  }
  function previewReasoning() {
    try {
      const settings = normalizeReasoning(readReasoningFields());
      const parameters = applyReasoning({ model: '__preview' }, settings, $('connection-protocol').value); delete parameters.model;
      $('reasoning-request-preview').textContent = JSON.stringify(parameters, null, 2);
      $('reasoning-validation-error').hidden = true;
    } catch (error) {
      $('reasoning-request-preview').textContent = error.message;
      $('reasoning-validation-error').textContent = error.message; $('reasoning-validation-error').hidden = false;
    }
    const capability = discoveredCapabilities[reasoningScope || selection.defaultModel];
    $('connection-effort-options').replaceChildren();
    for (const effort of capability?.efforts || []) { const option = el('option'); option.value = effort; $('connection-effort-options').append(option); }
    $('reasoning-capability-hint').textContent = capability?.efforts?.length
      ? `服务声明的思考档位：${capability.efforts.join(' / ')}${capability.default_effort ? `；默认 ${capability.default_effort}` : ''}。仅供参考，也可手填其他原始值。`
      : '留空不发送强度；none 与留空含义不同。支持值取决于实际模型和服务。';
  }
  function loadReasoningScope() {
    const independent = Boolean(reasoningScope && Object.hasOwn(modelReasoning, reasoningScope));
    const settings = independent ? modelReasoning[reasoningScope] : reasoningDefaults;
    $('reasoning-scope-label').textContent = reasoningScope ? `${reasoningScope} 的思考设置` : '连接默认思考设置';
    $('reasoning-defaults').hidden = !reasoningScope;
    $('reasoning-override-field').hidden = !reasoningScope;
    $('reasoning-model-override').checked = independent;
    $('connection-reasoning').value = settings.reasoning_effort || '';
    $('connection-thinking-format').value = settings.thinking_format || 'effort';
    $('connection-thinking-mode').value = settings.thinking_mode || '';
    $('connection-thinking-budget').value = settings.thinking_budget ?? '';
    $('reasoning-settings-fields').disabled = $('connection-kind').value === 'profile' || Boolean(reasoningScope && !independent);
    previewReasoning();
  }
  function syncFields() {
    const profile = $('connection-kind').value === 'profile'; const auth = $('connection-auth').value;
    $('endpoint-fields').hidden = profile; $('profile-fields').hidden = !profile;
    $('connection-advanced').hidden = profile;
    $('connection-base-url').required = !profile;
    $('connection-profile').required = profile;
    $('connection-profile').disabled = !profile;
    for (const field of $('endpoint-fields').querySelectorAll('input, select')) field.disabled = profile;
    for (const field of $('connection-advanced').querySelectorAll('input, select')) field.disabled = profile;
    $('stored-auth-field').hidden = auth !== 'stored'; $('env-auth-field').hidden = auth !== 'env';
    $('connection-env-var').required = !profile && auth === 'env';
    const existing = config?.connections.find(c => c.id === editingId);
    $('connection-api-key').required = !profile && auth === 'stored' && !existing?.has_api_key;
    $('discover-models').hidden = profile;
    $('test-connection').textContent = profile ? '检查配置' : '测试连接';
    $('connection-test-hint').textContent = profile ? '此连接沿用已有 Codex 配置，检查不会调用模型。' : '连接测试使用默认模型及其思考设置，可能计入该服务的用量。';
    $('reasoning-settings-fields').disabled = profile || Boolean(reasoningScope && !$('reasoning-model-override').checked);
    renderModels();
  }
  function draft() {
    saveReasoningScope();
    return {
      name: $('connection-name').value.trim(), kind: $('connection-kind').value === 'profile' ? 'profile' : config?.connections.find(c => c.id === editingId)?.kind || 'api',
      profile: $('connection-profile').value.trim(),
      protocol: $('connection-protocol').value, base_url: $('connection-base-url').value.trim(),
      auth_mode: $('connection-auth').value, api_key: $('connection-api-key').value,
      api_key_env: $('connection-env-var').value.trim(), auth_header: $('connection-auth-header').value.trim(),
      models: [...modelsOf()], default_model: selection.defaultModel,
      context_window: $('connection-context-window').value, ...reasoningDefaults,
      model_reasoning: Object.fromEntries(Object.entries(modelReasoning).filter(([model]) => modelsOf().includes(model))),
      enabled: $('connection-enabled').checked,
    };
  }
  function signature() {
    const input = draft(); const normalized = normalizeReasoning(input);
    for (const field of ['reasoning_effort', 'thinking_format', 'thinking_mode', 'thinking_budget']) delete input[field];
    input.model_reasoning = Object.fromEntries(Object.entries(input.model_reasoning).sort(([a], [b]) => a.localeCompare(b)).map(([model, settings]) => [model, normalizeReasoning(settings)]));
    return JSON.stringify({ ...input, ...normalized, pending_models: $('model-id-input').value });
  }
  function populate(connection = null) {
    if (editingId !== connection?.id) { discoveredCapabilities = {}; discoveredModels = []; }
    editingId = connection?.id || null;
    $('connection-editor-title').textContent = connection ? '编辑连接' : '添加模型连接';
    $('connection-editor-hint').textContent = connection?.kind === 'profile' ? '直接使用本机已有 profile 启动子代理。' : '本地服务、远程 API 和代理路由使用同一套连接设置。保存后，子 CLI 通过临时参数使用此连接。';
    $('connection-form').reset();
    $('connection-name').value = connection?.name || '';
    $('connection-kind').value = connection?.kind === 'profile' ? 'profile' : 'api';
    $('connection-kind').disabled = Boolean(connection);
    $('connection-kind-field').hidden = Boolean(connection);
    $('connection-type-label').hidden = !connection;
    $('connection-type-label').textContent = connection?.kind === 'profile' ? 'Codex profile' : 'API 连接';
    $('reasoning-preview').open = false;
    $('connection-protocol').value = connection?.protocol === 'chat_completions' ? 'chat_completions' : 'responses';
    $('connection-base-url').value = connection?.base_url || '';
    $('connection-auth').value = connection?.auth_mode || 'none';
    $('connection-auth').querySelector('option[value="stored"]').disabled = !config?.secret_storage_supported;
    $('connection-api-key').value = '';
    $('connection-api-key').placeholder = connection?.has_api_key ? '已加密保存；留空保持现有密钥' : '输入此服务的 API Key';
    $('connection-api-key').type = 'password'; $('show-api-key').checked = false;
    $('connection-env-var').value = connection?.api_key_env || '';
    $('connection-auth-header').value = connection?.auth_header || 'Authorization';
    reasoningDefaults = { reasoning_effort: connection?.reasoning_effort || '', thinking_format: connection?.thinking_format || 'effort', thinking_mode: connection?.thinking_mode || '', thinking_budget: connection?.thinking_budget ?? '' };
    selection = new ModelSelection(connection || {}); modelReasoning = selection.overrides; reasoningScope = '';
    loadReasoningScope();
    $('connection-context-window').value = connection?.context_window || '';
    $('connection-enabled').checked = connection?.enabled !== false;
    $('connection-profile').value = connection?.profile || '';
    $('export-connection').hidden = !connection || connection.kind === 'profile';
    $('export-connection').title = '导出已保存的配置；未保存的修改不包含在内';
    $('remove-connection').hidden = !connection;
    $('connection-more').hidden = !connection; $('connection-more').open = false;
    $('remove-connection').disabled = connection?.id === config?.default_connection_id;
    $('remove-connection').title = connection?.id === config?.default_connection_id ? '先选择另一个默认连接，才能移除此连接' : '移除模型连接';
    $('test-connection').disabled = !connection;
    result(); syncFields(); renderCards(); savedSignature = signature();
  }
  function renderCards() {
    if (!config) return;
    $('connection-count').textContent = `${config.connections.length} 个连接`;
    $('remove-connection').disabled = editingId === config.default_connection_id;
    $('remove-connection').title = editingId === config.default_connection_id ? '先选择另一个默认连接，才能移除此连接' : '移除模型连接';
    const fragment = document.createDocumentFragment();
    for (const connection of config.connections) {
      const card = el('article', `connection-card${connection.id === editingId ? ' selected' : ''}`);
      const heading = el('div', 'connection-card-heading'); const title = el('button', 'connection-card-title', connection.name); title.type = 'button'; title.addEventListener('click', () => { if (!busy) populate(connection); });
      heading.append(title);
      if (connection.id === config.default_connection_id) heading.append(el('span', 'default-badge', '默认'));
      else if (!connection.enabled) heading.append(el('span', 'disabled-badge', '已停用'));
      card.append(heading, el('div', 'connection-card-meta', `${kinds[connection.kind]} · ${protocols[connection.protocol]}`));
      if (connection.base_url) { const endpoint = el('div', 'connection-card-endpoint', connection.base_url); endpoint.title = connection.base_url; card.append(endpoint); }
      const controls = el('div', 'connection-card-controls');
      const button = el('button', 'set-default-button', '设为默认连接'); button.type = 'button'; button.disabled = !connection.enabled;
      button.addEventListener('click', async () => {
        if (busy) return;
        try { config = await api('/api/config/default', { method: 'PATCH', ...payload({ connection_id: connection.id, model: connection.default_model }) }); renderCards(); toast('新任务将使用所选连接'); onSaved(config); } catch (error) { toast(error.message); }
      });
      if (connection.id !== config.default_connection_id) { controls.append(button); card.append(controls); } fragment.append(card);
    }
    $('connections-list').replaceChildren(fragment);
  }
  async function save() {
    if (busy || !$('connection-form').reportValidity()) return;
    try { commitModelInput(); if (!modelsOf().length) throw new Error('请至少添加一个模型。'); } catch (error) { result(error.message, false); $('model-id-input').focus(); return; }
    busyState(true); result();
    try {
      const input = draft(); const previousId = editingId;
      config = await api(previousId ? `/api/config/connections/${previousId}` : '/api/config/connections', { method: previousId ? 'PUT' : 'POST', ...payload(input) });
      const saved = previousId ? config.connections.find(c => c.id === previousId) : config.connections.at(-1);
      populate(saved); toast('模型连接已保存'); onSaved(config);
    } catch (error) { result(error.message, false); }
    finally { busyState(false); }
  }
  async function testConnection() {
    if (busy || !editingId) return;
    try { if (signature() !== savedSignature) throw new Error(); } catch { result('有未保存的修改，请先保存后再测试。', false); return; }
    busyState(true); result('正在检查已保存的连接…');
    try {
      const check = await api(`/api/config/connections/${editingId}/test`, { method: 'POST', ...payload({ model: selection.defaultModel }) });
      result(`${check.message}${check.latency_ms ? ` 耗时 ${(check.latency_ms / 1000).toFixed(1)} 秒。` : ''}`, check.tool_calling !== false);
    } catch (error) { result(error.message, false); } finally { busyState(false); }
  }
  $('connection-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  $('test-connection').addEventListener('click', () => { void testConnection(); });
  $('new-connection').addEventListener('click', () => { if (!busy) { populate(); $('connection-name').focus(); } });
  $('add-model').addEventListener('click', () => { if (busy) return; try { commitModelInput(); } catch (error) { result(error.message, false); } });
  $('reasoning-defaults').addEventListener('click', () => { saveReasoningScope(); reasoningScope = ''; loadReasoningScope(); renderModels(); });
  $('reasoning-model-override').addEventListener('change', () => { saveReasoningScope(); loadReasoningScope(); });
  for (const id of ['connection-reasoning', 'connection-thinking-format', 'connection-thinking-mode', 'connection-thinking-budget', 'connection-protocol']) $(id).addEventListener('input', previewReasoning);
  $('connection-auth').addEventListener('change', syncFields);
  $('connection-kind').addEventListener('change', syncFields);
  $('show-api-key').addEventListener('change', () => { $('connection-api-key').type = $('show-api-key').checked ? 'text' : 'password'; });
  $('discover-models').addEventListener('click', async () => {
    if (busy) return;
    const input = draft(); if (!input.name) input.name = '未命名连接';
    busyState(true); result('正在读取此接口的模型列表…');
    try {
      const discovered = await api('/api/config/discover', { method: 'POST', ...payload({ connection: input, connection_id: editingId }) });
      discoveredCapabilities = discovered.capabilities || {}; previewReasoning();
      discoveredModels = discovered.models; renderModels();
      result(`已读取 ${discovered.models.length} 个模型，候选项已列在下方；点击添加后才会保存。`);
    } catch (error) { result(error.message, false); } finally { busyState(false); }
  });
  $('export-connection').addEventListener('click', async () => {
    if (!editingId || busy) return;
    $('connection-more').open = false;
    busyState(true);
    try {
      exported = await api(`/api/config/connections/${editingId}/export-profile`, { method: 'POST' });
      for (const field of ['note', 'target', 'content', 'launch']) $(`export-profile-${field}`).textContent = exported[field];
      $('export-profile-dialog').showModal();
    } catch (error) { toast(error.message); }
    finally { busyState(false); }
  });
  $('download-profile').addEventListener('click', () => {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported.content], { type: 'text/plain;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = exported.filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('remove-connection').addEventListener('click', () => { if (!editingId || busy) return; $('connection-more').open = false; pendingDelete = editingId; $('delete-connection-dialog').showModal(); });
  document.addEventListener('click', event => { if (!$('connection-more').contains(event.target)) $('connection-more').open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('connection-more').open) { $('connection-more').open = false; $('connection-more').querySelector('summary').focus(); } });
  $('confirm-remove-connection').addEventListener('click', async () => {
    if (!pendingDelete) return;
    try { config = await api(`/api/config/connections/${pendingDelete}`, { method: 'DELETE' }); pendingDelete = null; $('delete-connection-dialog').close(); populate(config.connections.find(c => c.id === config.default_connection_id)); toast('连接已移除'); onSaved(config); } catch (error) { toast(error.message); }
  });
  return {
    async show() {
      $('settings-page').hidden = false;
      $('new-connection').hidden = false;
      try { config = await api('/api/config'); $('settings-load-error').hidden = true; populate(config.connections.find(c => c.id === editingId) || config.connections.find(c => c.id === config.default_connection_id)); }
      catch (error) { $('settings-load-error').textContent = error.message; $('settings-load-error').hidden = false; }
    },
    hide() { $('settings-page').hidden = true; $('new-connection').hidden = true; },
  };
}
