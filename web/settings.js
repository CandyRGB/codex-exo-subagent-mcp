import { applyReasoning, normalizeReasoning } from './reasoning.js';
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const kinds = { profile: '已有 Codex profile', local: '模型 API 连接', api: '模型 API 连接', router: '模型 API 连接' };
const protocols = { profile: 'Codex profile', responses: 'Responses', chat_completions: 'Chat Completions' };
const modelsOf = () => [...new Set($('connection-models').value.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean))];

export function createModelSettings({ toast, onSaved = () => {} }) {
  let config = null, editingId = null, pendingDelete = null, busy = false, exported = null;
  let reasoningDefaults = {}, modelReasoning = Object.create(null), reasoningScope = '', discoveredCapabilities = {};
  async function api(path, options = {}) {
    const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || '模型配置操作失败'); return data;
  }
  const payload = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  function result(message = '', ok = true) { const target = $('connection-test-result'); target.hidden = !message; target.textContent = message; target.className = `connection-test-result${ok ? ' success' : ' error'}`; }
  function busyState(value) {
    busy = value;
    for (const id of ['save-connection', 'save-test-connection', 'discover-models', 'new-connection', 'export-connection']) $(id).disabled = value;
    $('save-connection').textContent = value ? '正在处理…' : '保存连接';
  }
  function syncModels(selected = $('connection-default-model').value) {
    saveReasoningScope();
    const models = modelsOf(); $('connection-default-model').replaceChildren();
    for (const model of models) { const option = el('option', '', model); option.value = model; $('connection-default-model').append(option); }
    $('connection-default-model').value = models.includes(selected) ? selected : models[0] || '';
    $('reasoning-scope').replaceChildren();
    const base = el('option', '', '连接默认值'); base.value = ''; $('reasoning-scope').append(base);
    for (const model of models) { const option = el('option', '', model); option.value = model; $('reasoning-scope').append(option); }
    if (!models.includes(reasoningScope)) reasoningScope = '';
    $('reasoning-scope').value = reasoningScope; loadReasoningScope();
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
    } catch (error) { $('reasoning-request-preview').textContent = error.message; }
    const capability = discoveredCapabilities[reasoningScope || $('connection-default-model').value];
    $('connection-effort-options').replaceChildren();
    for (const effort of capability?.efforts || []) { const option = el('option'); option.value = effort; $('connection-effort-options').append(option); }
    $('reasoning-capability-hint').textContent = capability?.efforts?.length
      ? `服务声明的思考档位：${capability.efforts.join(' / ')}${capability.default_effort ? `；默认 ${capability.default_effort}` : ''}。仅供参考，也可手填其他原始值。`
      : '留空不发送强度；none 与留空含义不同。支持值取决于实际模型和服务。';
  }
  function loadReasoningScope() {
    const independent = Boolean(reasoningScope && Object.hasOwn(modelReasoning, reasoningScope));
    const settings = independent ? modelReasoning[reasoningScope] : reasoningDefaults;
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
    $('save-test-connection').textContent = profile ? '保存并检查' : '保存并测试';
    $('connection-test-hint').textContent = profile ? '此连接沿用已有 Codex 配置，检查不会调用模型。' : '连接测试使用默认模型及其思考设置，可能计入该服务的用量。';
    $('reasoning-settings-fields').disabled = profile || Boolean(reasoningScope && !$('reasoning-model-override').checked);
  }
  function draft() {
    saveReasoningScope();
    return {
      name: $('connection-name').value.trim(), kind: $('connection-kind').value === 'profile' ? 'profile' : config?.connections.find(c => c.id === editingId)?.kind || 'api',
      profile: $('connection-profile').value.trim(),
      protocol: $('connection-protocol').value, base_url: $('connection-base-url').value.trim(),
      auth_mode: $('connection-auth').value, api_key: $('connection-api-key').value,
      api_key_env: $('connection-env-var').value.trim(), auth_header: $('connection-auth-header').value.trim(),
      models: modelsOf(), default_model: $('connection-default-model').value,
      context_window: $('connection-context-window').value, ...reasoningDefaults,
      model_reasoning: Object.fromEntries(Object.entries(modelReasoning).filter(([model]) => modelsOf().includes(model))),
      enabled: $('connection-enabled').checked,
    };
  }
  function populate(connection = null) {
    if (editingId !== connection?.id) discoveredCapabilities = {};
    editingId = connection?.id || null;
    $('connection-editor-title').textContent = connection ? '编辑连接' : '添加模型连接';
    $('connection-editor-hint').textContent = connection?.kind === 'profile' ? '直接使用本机已有 profile 启动子代理。' : '本地服务、远程 API 和代理路由使用同一套连接设置。保存后，子 CLI 通过临时参数使用此连接。';
    $('connection-form').reset();
    $('connection-name').value = connection?.name || '';
    $('connection-kind').value = connection?.kind === 'profile' ? 'profile' : 'api';
    $('connection-kind').disabled = Boolean(connection);
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
    modelReasoning = Object.assign(Object.create(null), connection?.model_reasoning || {}); reasoningScope = '';
    loadReasoningScope();
    $('connection-models').value = (connection?.models || []).join('\n'); syncModels(connection?.default_model);
    $('connection-context-window').value = connection?.context_window || '';
    $('connection-enabled').checked = connection?.enabled !== false;
    $('connection-profile').value = connection?.profile || '';
    $('export-connection').hidden = !connection || connection.kind === 'profile';
    $('export-connection').title = '导出已保存的配置；未保存的修改不包含在内';
    $('remove-connection').hidden = !connection;
    $('remove-connection').disabled = connection?.id === config?.default_connection_id;
    $('remove-connection').title = connection?.id === config?.default_connection_id ? '先选择另一个默认连接，才能移除此连接' : '移除模型连接';
    $('discovered-models-wrap').hidden = true; result(); syncFields(); renderCards();
  }
  function renderCards() {
    if (!config) return;
    const chosen = config.connections.find(c => c.id === config.default_connection_id);
    $('settings-default-name').textContent = chosen?.name || '尚未选择';
    $('settings-default-model').textContent = chosen?.default_model || '—';
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
      const controls = el('div', 'connection-card-controls'); const models = el('select', 'connection-card-model'); models.setAttribute('aria-label', `${connection.name} 默认模型`);
      for (const id of connection.models) { const option = el('option', '', id); option.value = id; models.append(option); } models.value = connection.default_model;
      const button = el('button', 'set-default-button', '设为默认'); button.type = 'button';
      const update = () => { button.disabled = !connection.enabled || connection.id === config.default_connection_id && models.value === connection.default_model; };
      models.addEventListener('change', update); update();
      button.addEventListener('click', async () => {
        if (busy) return;
        try { config = await api('/api/config/default', { method: 'PATCH', ...payload({ connection_id: connection.id, model: models.value }) }); if (editingId === connection.id && modelsOf().includes(models.value)) $('connection-default-model').value = models.value; renderCards(); toast('新任务将使用所选默认模型'); onSaved(config); } catch (error) { toast(error.message); }
      });
      controls.append(models, button); card.append(controls); fragment.append(card);
    }
    $('connections-list').replaceChildren(fragment);
  }
  async function save(testConnection = false) {
    if (busy || !$('connection-form').reportValidity()) return;
    busyState(true); result();
    try {
      const input = draft(); const previousId = editingId;
      config = await api(previousId ? `/api/config/connections/${previousId}` : '/api/config/connections', { method: previousId ? 'PUT' : 'POST', ...payload(input) });
      const saved = previousId ? config.connections.find(c => c.id === previousId) : config.connections.at(-1);
      populate(saved); toast('模型连接已保存'); onSaved(config);
      if (testConnection) {
        result('正在验证接口、流式响应与工具调用…');
        const check = await api(`/api/config/connections/${saved.id}/test`, { method: 'POST', ...payload({ model: saved.default_model }) });
        result(`${check.message}${check.latency_ms ? ` 耗时 ${(check.latency_ms / 1000).toFixed(1)} 秒。` : ''}`, check.tool_calling !== false);
      }
    } catch (error) { result(error.message, false); }
    finally { busyState(false); }
  }
  $('connection-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  $('save-test-connection').addEventListener('click', () => { void save(true); });
  $('new-connection').addEventListener('click', () => { if (!busy) { populate(); $('connection-name').focus(); } });
  $('connection-models').addEventListener('input', () => syncModels());
  $('reasoning-scope').addEventListener('change', () => { saveReasoningScope(); reasoningScope = $('reasoning-scope').value; loadReasoningScope(); });
  $('reasoning-model-override').addEventListener('change', () => { saveReasoningScope(); loadReasoningScope(); });
  for (const id of ['connection-reasoning', 'connection-thinking-format', 'connection-thinking-mode', 'connection-thinking-budget', 'connection-protocol', 'connection-default-model']) $(id).addEventListener('input', previewReasoning);
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
      const options = document.createDocumentFragment(); for (const model of discovered.models) { const option = el('option'); option.value = model; options.append(option); }
      $('discovered-model-list').replaceChildren(options); $('discovered-models-wrap').hidden = false;
      result(`已读取 ${discovered.models.length} 个模型。选择所需模型并添加到列表，也可以手动填写。`);
    } catch (error) { result(error.message, false); } finally { busyState(false); }
  });
  $('add-discovered-model').addEventListener('click', () => {
    const model = $('discovered-model-input').value.trim(); if (!model) return;
    $('connection-models').value = [...new Set([...modelsOf(), model])].join('\n'); syncModels(); $('discovered-model-input').value = '';
  });
  $('export-connection').addEventListener('click', async () => {
    if (!editingId || busy) return;
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
  $('remove-connection').addEventListener('click', () => { if (!editingId || busy) return; pendingDelete = editingId; $('delete-connection-dialog').showModal(); });
  $('confirm-remove-connection').addEventListener('click', async () => {
    if (!pendingDelete) return;
    try { config = await api(`/api/config/connections/${pendingDelete}`, { method: 'DELETE' }); pendingDelete = null; $('delete-connection-dialog').close(); populate(config.connections.find(c => c.id === config.default_connection_id)); toast('连接已移除'); onSaved(config); } catch (error) { toast(error.message); }
  });
  return {
    async show() {
      $('settings-page').hidden = false;
      try { config = await api('/api/config'); $('settings-load-error').hidden = true; populate(config.connections.find(c => c.id === editingId) || config.connections.find(c => c.id === config.default_connection_id)); }
      catch (error) { $('settings-load-error').textContent = error.message; $('settings-load-error').hidden = false; }
    },
    hide() { $('settings-page').hidden = true; },
  };
}
