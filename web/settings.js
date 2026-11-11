import { applyReasoning, normalizeReasoning } from './reasoning.js';
import { ModelSelection } from './model-selection.js';
import { createSelectMenus } from './dropdown.js';
import { inferenceEndpoint, normalizeApiBaseUrl } from './api-endpoint.js';
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const protocols = { profile: 'Codex profile', responses: 'Responses', chat_completions: 'Chat Completions' };

export function createModelSettings({ toast, onSaved = () => {} }) {
  const selects = createSelectMenus(document);
  let config = null, editingId = null, pendingDelete = null, busy = false, exported = null;
  let editorOpen = false, initialized = false;
  let reasoningDefaults = {}, modelReasoning = Object.create(null), reasoningScope = '', discoveredCapabilities = {};
  let selection = new ModelSelection(), discoveredModels = [], savedSignature = '';
  let revealedSavedKey = null;
  let keyRevealRequest = null;
  const apiKeyInput = $('connection-api-key');
  const apiKeyToggle = $('show-api-key');
  const modelsOf = () => selection.models;
  async function api(path, options = {}) {
    const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(60000) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || '模型配置操作失败'); return data;
  }
  const payload = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  function setApiKeyVisible(visible) {
    apiKeyInput.type = visible ? 'text' : 'password';
    const label = visible ? '隐藏 API Key' : '显示 API Key';
    apiKeyToggle.setAttribute('aria-label', label);
    apiKeyToggle.title = label;
    $('api-key-visibility-icon').setAttribute('href', visible ? '#i-eye-off' : '#i-eye');
  }
  function hideApiKey() {
    keyRevealRequest?.abort();
    keyRevealRequest = null;
    if (apiKeyInput.value.trim() === revealedSavedKey) apiKeyInput.value = '';
    revealedSavedKey = null;
    apiKeyToggle.disabled = false;
    setApiKeyVisible(false);
  }
  async function toggleApiKey() {
    if (apiKeyInput.type === 'text') {
      hideApiKey();
      return;
    }
    if (busy || keyRevealRequest) return;
    const connection = config?.connections.find(item => item.id === editingId);
    if (apiKeyInput.value || !connection?.has_api_key) {
      setApiKeyVisible(true);
      return;
    }
    const request = new AbortController();
    keyRevealRequest = request;
    apiKeyToggle.disabled = true;
    try {
      const data = await api(`/api/config/connections/${connection.id}/reveal-key`, {
        method: 'POST',
        ...payload({}),
        mode: 'same-origin',
        referrerPolicy: 'same-origin',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      });
      if (keyRevealRequest !== request || apiKeyInput.value) return;
      revealedSavedKey = data.api_key;
      apiKeyInput.value = revealedSavedKey;
      setApiKeyVisible(true);
    } catch (error) {
      if (keyRevealRequest === request) toast(error.message);
    } finally {
      if (keyRevealRequest === request) {
        keyRevealRequest = null;
        apiKeyToggle.disabled = false;
      }
    }
  }
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
    selects.refresh();
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
  function previewEndpoint() {
    const preview = $('connection-endpoint-preview');
    const value = $('connection-base-url').value.trim();
    preview.hidden = !value;
    preview.textContent = '';
    preview.className = 'endpoint-preview';
    if (!value) return;
    try {
      const baseUrl = normalizeApiBaseUrl(value);
      preview.textContent = `预览: ${inferenceEndpoint(baseUrl, $('connection-protocol').value)}`;
    } catch (error) {
      preview.textContent = error.message;
      preview.className = 'endpoint-preview invalid';
    }
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
    if (profile || auth !== 'stored') hideApiKey();
    $('connection-env-var').required = !profile && auth === 'env';
    const existing = config?.connections.find(c => c.id === editingId);
    $('connection-api-key').required = !profile && auth === 'stored' && existing?.auth_mode === 'stored' && !existing.has_api_key;
    $('discover-models').hidden = profile;
    $('test-connection').textContent = profile ? '检查配置' : '测试连接';
    $('connection-test-hint').textContent = profile ? '此连接沿用已有 Codex 配置，检查不会调用模型。' : '连接测试使用默认模型及其思考设置，可能计入该服务的用量。';
    $('reasoning-settings-fields').disabled = profile || Boolean(reasoningScope && !$('reasoning-model-override').checked);
    renderModels();
    selects.refresh();
    previewEndpoint();
  }
  function draft() {
    saveReasoningScope();
    const existing = config?.connections.find(c => c.id === editingId);
    const kind = $('connection-kind').value === 'profile' ? 'profile' : existing?.kind || 'api';
    let authMode = kind === 'profile' ? 'none' : $('connection-auth').value;
    const key = apiKeyInput.value.trim();
    const apiKey = authMode === 'stored' && key !== revealedSavedKey ? key : '';
    if (authMode === 'stored' && !apiKey && !existing?.has_api_key && existing?.auth_mode !== 'stored') {
      authMode = 'none';
    }
    return {
      name: $('connection-name').value.trim(), kind,
      profile: $('connection-profile').value.trim(),
      protocol: $('connection-protocol').value, base_url: $('connection-base-url').value.trim(),
      auth_mode: authMode, api_key: apiKey,
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
  function populate(connection = null, expand = true) {
    selects.close();
    hideApiKey();
    editorOpen = expand; initialized = true;
    if (editingId !== connection?.id) { discoveredCapabilities = {}; discoveredModels = []; }
    editingId = connection?.id || null;
    $('connection-form').reset();
    $('connection-name').value = connection?.name || '';
    $('connection-kind').value = connection?.kind === 'profile' ? 'profile' : 'api';
    $('connection-kind').disabled = Boolean(connection);
    $('connection-kind-field').hidden = Boolean(connection);
    $('connection-advanced').open = false;
    $('reasoning-preview').open = false;
    $('connection-protocol').value = connection?.protocol === 'chat_completions' ? 'chat_completions' : 'responses';
    $('connection-base-url').value = connection?.base_url || '';
    const supportsStoredKey = config?.secret_storage_supported;
    const savedAuthMode = connection?.auth_mode || 'none';
    $('connection-auth').value = savedAuthMode === 'none' && supportsStoredKey && connection?.kind !== 'profile' ? 'stored' : savedAuthMode;
    $('connection-auth').querySelector('option[value="stored"]').disabled = !supportsStoredKey;
    apiKeyInput.value = '';
    apiKeyInput.placeholder = connection?.has_api_key ? '........' : '可留空';
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
    hideApiKey();
    $('remove-connection').disabled = editingId === config.default_connection_id;
    $('remove-connection').title = editingId === config.default_connection_id ? '先选择另一个默认连接，才能移除此连接' : '移除模型连接';
    // Park the shared form before replacing the rows so its values and listeners survive.
    const editor = $('connection-editor'); $('connection-editor-home').append(editor); editor.hidden = true;
    const fragment = document.createDocumentFragment();
    function row(connection = null) {
      const id = connection?.id || 'new', name = connection?.name || '新连接';
      const expanded = editorOpen && editingId === (connection?.id || null);
      const card = el('article', `connection-card${expanded ? ' selected' : ''}`); card.id = `connection-row-${id}`;
      const heading = el('div', 'connection-row'), info = el('div', 'connection-row-info');
      const title = el('span', 'connection-card-title', name);
      title.id = `connection-title-${id}`;
      title.title = name;
      info.append(title);
      if (connection) {
        info.append(el('span', 'connection-card-meta', protocols[connection.protocol]));
        const model = el('span', 'connection-card-model', connection.default_model || ''); model.title = connection.default_model || ''; info.append(model);
      }
      heading.append(info);
      if (connection?.id === config.default_connection_id) heading.append(el('span', 'default-badge', '默认'));
      if (connection && !connection.enabled) heading.append(el('span', 'disabled-badge', '已停用'));
      const actions = el('div', 'connection-row-actions');
      if (connection && connection.id !== config.default_connection_id) {
        const button = el('button', 'set-default-button', '设为默认连接'); button.type = 'button'; button.disabled = !connection.enabled;
        button.addEventListener('click', async () => {
          if (busy) return;
          try { config = await api('/api/config/default', { method: 'PATCH', ...payload({ connection_id: connection.id, model: connection.default_model }) }); renderCards(); toast('新任务将使用所选连接'); onSaved(config); } catch (error) { toast(error.message); }
        }); actions.append(button);
      }
      const toggle = el('button', 'connection-expand icon-button'); toggle.id = `connection-toggle-${id}`; toggle.type = 'button';
      toggle.setAttribute('aria-label', `${expanded ? '收起' : '编辑'} ${name}`); toggle.title = expanded ? '收起' : '展开编辑';
      toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-controls', 'connection-editor');
      toggle.append(el('span', 'connection-expand-arrow'));
      toggle.addEventListener('click', () => {
        if (busy) return;
        selects.close();
        if (editingId === (connection?.id || null)) { editorOpen = !editorOpen; renderCards(); }
        else populate(connection);
        ($(`connection-toggle-${id}`) || $('new-connection')).focus();
      });
      actions.append(toggle); heading.append(actions); card.append(heading);
      if (expanded) {
        editor.setAttribute('aria-labelledby', title.id);
        card.append(editor);
        editor.hidden = false;
      }
      return card;
    }
    if (editorOpen && !editingId) fragment.append(row());
    for (const connection of config.connections) {
      fragment.append(row(connection));
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
  $('new-connection').addEventListener('click', () => { if (!busy) { if (initialized && !editingId) { editorOpen = true; renderCards(); } else populate(); $('connection-name').focus(); } });
  $('add-model').addEventListener('click', () => { if (busy) return; try { commitModelInput(); } catch (error) { result(error.message, false); } });
  $('reasoning-defaults').addEventListener('click', () => { saveReasoningScope(); reasoningScope = ''; loadReasoningScope(); renderModels(); });
  $('reasoning-model-override').addEventListener('change', () => { saveReasoningScope(); loadReasoningScope(); });
  for (const id of ['connection-reasoning', 'connection-thinking-format', 'connection-thinking-mode', 'connection-thinking-budget', 'connection-protocol']) $(id).addEventListener('input', previewReasoning);
  $('connection-protocol').addEventListener('input', previewEndpoint);
  $('connection-base-url').addEventListener('input', previewEndpoint);
  $('connection-auth').addEventListener('change', syncFields);
  $('connection-kind').addEventListener('change', syncFields);
  apiKeyToggle.addEventListener('click', toggleApiKey);
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
    try { config = await api(`/api/config/connections/${pendingDelete}`, { method: 'DELETE' }); pendingDelete = null; $('delete-connection-dialog').close(); populate(config.connections.find(c => c.id === config.default_connection_id), false); toast('连接已移除'); onSaved(config); } catch (error) { toast(error.message); }
  });
  return {
    async show() {
      $('settings-page').hidden = false;
      $('new-connection').hidden = false;
      try {
        config = await api('/api/config');
        const profileInput = $('connection-profile');
        const example = '例如 deepseek.config.toml 填写 deepseek';
        const hint = config.codex_home ? `文件位于 ${config.codex_home}，${example}` : example;
        profileInput.placeholder = hint;
        profileInput.title = hint;
        $('settings-load-error').hidden = true;
        if (initialized && !editingId) {
          renderCards();
        } else {
          const connection = config.connections.find(c => c.id === editingId)
            || config.connections.find(c => c.id === config.default_connection_id);
          populate(connection, editorOpen);
        }
      } catch (error) {
        $('settings-load-error').textContent = error.message;
        $('settings-load-error').hidden = false;
      }
    },
    hide() {
      selects.close();
      hideApiKey();
      $('settings-page').hidden = true;
      $('new-connection').hidden = true;
    },
  };
}
