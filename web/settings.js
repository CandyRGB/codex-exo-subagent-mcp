import { normalizeReasoning } from './reasoning.js';
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
  let discoveredCapabilities = {}, editingModel = null;
  let selection = new ModelSelection(), discoveredModels = [], savedSignature = '';
  let revealedSavedKey = null;
  let keyRevealRequest = null;
  const apiKeyInput = $('connection-api-key');
  const apiKeyToggle = $('show-api-key');
  const modelDialog = $('model-dialog');
  let modelRequest = null;
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
      if (keyRevealRequest === request) toast(error.message, 'danger');
    } finally {
      if (keyRevealRequest === request) {
        keyRevealRequest = null;
        apiKeyToggle.disabled = false;
      }
    }
  }
  function result(message = '', type = 'info', persistent = false) {
    toast(message, type, { key: 'connection-operation', persistent });
  }
  function busyState(value) {
    busy = value;
    for (const id of ['save-connection', 'test-connection', 'discover-models', 'new-connection', 'export-connection', 'add-model', 'check-api-service']) $(id).disabled = value;
    $('test-connection').disabled = value || !editingId;
    $('save-connection').textContent = value ? '正在处理…' : '保存连接';
  }
  function modelAction(iconName, label, handler, destructive = false) {
    const button = el('button', `icon-button model-action${destructive ? ' model-action-delete' : ''}`);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${iconName}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.append(use);
    button.append(svg);
    button.addEventListener('click', handler);
    return button;
  }
  function renderModels() {
    const rows = document.createDocumentFragment();
    const connection = config?.connections.find(item => item.id === editingId) || {};
    const candidates = discoveredModels.filter(model => !modelsOf().includes(model));
    for (const model of [...modelsOf(), ...candidates]) {
      const added = modelsOf().includes(model);
      const row = el('tr');
      const name = el('td');
      name.append(el('code', '', model));
      if (added) {
        const limits = selection.limits[model] || {};
        const context = limits.context_window || connection.context_window;
        const thinking = selection.overrides[model] || connection;
        const effort = thinking.reasoning_effort;
        const profile = $('connection-kind').value === 'profile';
        const parameters = profile ? ['由 profile 配置'] : [
          context ? `上下文 ${context.toLocaleString()}` : '上下文 自动',
          limits.max_output_tokens ? `输出 ${limits.max_output_tokens.toLocaleString()}` : '输出 自动',
          effort ? `思考 ${effort}` : '',
        ].filter(Boolean);
        name.append(el('span', 'model-parameters', parameters.join(' · ')));
      } else {
        name.append(el('span', 'model-candidate', '未添加'));
      }
      const chosen = el('td');
      if (added) {
        const radio = el('input'); radio.type = 'radio'; radio.name = 'default-model'; radio.checked = model === selection.defaultModel;
        radio.setAttribute('aria-label', `将 ${model} 设为默认模型`);
        radio.addEventListener('change', () => {
          if (busy) return;
          selection.setDefault(model);
          renderModels();
        });
        const hit = el('label', 'model-default-hit');
        hit.append(radio);
        chosen.append(hit);
      }
      const actions = el('td'); const group = el('div', 'model-row-actions');
      if (added) {
        group.append(modelAction('edit', `编辑模型 ${model}`, () => openModelDialog(model, true)));
        group.append(modelAction('trash', `删除模型 ${model}`, () => {
          if (busy) return;
          selection.remove(model);
          renderModels();
        }, true));
      } else {
        group.append(modelAction('plus', `添加模型 ${model}`, () => openModelDialog(model)));
      }
      actions.append(group); row.append(name, chosen, actions); rows.append(row);
    }
    if (!modelsOf().length && !candidates.length) { const row = el('tr'); const cell = el('td', 'empty-models', '添加模型或获取模型列表。'); cell.colSpan = 3; row.append(cell); rows.append(row); }
    $('model-rows').replaceChildren(rows);
  }
  function savedEffortScheme(settings) {
    if (settings?.effort_set === 'provider') return 'provider';
    return settings && Object.keys(settings).length ? 'custom' : 'service';
  }
  function selectedEffort() {
    return $('model-effort-set').value === 'custom'
      ? $('model-custom-effort').value.trim()
      : $('model-reasoning').value;
  }
  function readModelReasoning() {
    const set = $('model-effort-set').value;
    if (set === 'service') return {};
    const effort = selectedEffort();
    const previous = selection.overrides[editingModel];
    if (previous && savedEffortScheme(previous) === set && (previous.reasoning_effort || '') === effort) {
      return previous;
    }
    return normalizeReasoning({
      reasoning_effort: effort,
      ...(set === 'provider' ? { effort_set: 'provider' } : {}),
    });
  }
  function modelResult(message = '', type = 'info', persistent = false) {
    toast(message, type, { key: 'model-operation', persistent });
  }
  function reportedModelEfforts() {
    const model = $('model-id-input').value.trim();
    return Object.hasOwn(discoveredCapabilities, model) ? discoveredCapabilities[model].efforts || [] : [];
  }
  function syncModelEffort(value) {
    const set = $('model-effort-set').value;
    const reported = reportedModelEfforts();
    const levels = set === 'provider' ? new Set(['', ...reported, value]) : [''];
    const effortSelect = $('model-reasoning');
    effortSelect.replaceChildren();
    for (const effort of levels) {
      const option = el('option', '', effort || '服务默认');
      option.value = effort;
      effortSelect.append(option);
    }
    effortSelect.value = set === 'provider' ? value : '';
    $('model-custom-effort').value = set === 'custom' ? value : '';
    $('model-effort-field').hidden = set === 'service' || set === 'custom';
    $('read-model-efforts').hidden = set !== 'provider';
    $('model-custom-effort-field').hidden = set !== 'custom';
    selects.refresh();
  }
  function announceMissingEfforts() {
    if ($('model-effort-set').value === 'provider' && !reportedModelEfforts().length) {
      modelResult('当前没有该模型的档位数据，可点击“读取档位”。');
    }
  }
  function openModelDialog(model = '', editing = false) {
    if (busy) return;
    hideApiKey();
    selects.close();
    editingModel = editing ? model : null;
    const profile = $('connection-kind').value === 'profile';
    const limits = editing ? selection.limits[model] || {} : {};
    const thinking = editing ? selection.overrides[model] : undefined;
    $('model-dialog-title').textContent = editing ? '编辑模型' : '添加模型';
    $('model-id-input').value = model;
    $('model-context-window').value = limits.context_window ?? '';
    $('model-max-output').value = limits.max_output_tokens ?? '';
    $('model-parameter-fields').hidden = profile;
    for (const field of $('model-parameter-fields').querySelectorAll('input, select')) field.disabled = profile;
    $('test-model-draft').hidden = profile;
    $('model-effort-set').value = savedEffortScheme(thinking);
    syncModelEffort(thinking?.reasoning_effort || '');
    modelResult();
    modelDialog.showModal();
    announceMissingEfforts();
    $('model-id-input').focus();
  }
  function readModelDraft() {
    const model = $('model-id-input').value.trim();
    const profile = $('connection-kind').value === 'profile';
    const limits = {};
    if (!profile) {
      for (const [field, id, minimum] of [['context_window', 'model-context-window', 2048], ['max_output_tokens', 'model-max-output', 1]]) {
        const raw = $(id).value;
        if (raw === '') continue;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < minimum || value > 4_000_000) throw new Error('请输入有效的 Token 数。');
        limits[field] = value;
      }
    }
    const thinking = profile ? null : readModelReasoning();
    const candidate = new ModelSelection(selection.snapshot());
    candidate.update(editingModel, model, limits, thinking);
    return { model, candidate };
  }
  function setModelRequest(request) {
    modelRequest = request;
    for (const id of ['read-model-efforts', 'test-model-draft', 'save-model-draft']) $(id).disabled = Boolean(request);
  }
  function closeModelDialog() {
    selects.close();
    modelRequest?.abort();
    setModelRequest(null);
    modelResult();
    if (modelDialog.open) modelDialog.close();
  }
  async function testModelDraft() {
    if (modelRequest || !$('model-dialog-form').reportValidity()) return;
    let input;
    let model;
    try {
      const next = readModelDraft();
      model = next.model;
      input = draft(next.candidate);
      if (!input.name) input.name = '未命名连接';
    } catch (error) {
      modelResult(error.message, 'warning');
      return;
    }
    const request = new AbortController();
    setModelRequest(request);
    modelResult('正在测试模型…', 'info', true);
    try {
      const check = await api('/api/config/test-model', {
        method: 'POST',
        ...payload({ connection: input, connection_id: editingId, model }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(50000)]),
      });
      if (modelRequest === request) modelResult(check.message, check.tool_calling === false ? 'warning' : 'info');
    } catch (error) {
      if (modelRequest === request) modelResult(error.message, 'danger');
    } finally {
      if (modelRequest === request) setModelRequest(null);
    }
  }
  async function readModelEfforts() {
    if (modelRequest || !modelDialog.open) return;
    if (!$('model-id-input').value.trim()) {
      modelResult('请先填写模型 ID。', 'warning');
      $('model-id-input').focus();
      return;
    }
    const request = new AbortController();
    setModelRequest(request);
    modelResult('正在读取服务档位…', 'info', true);
    try {
      const catalog = await discoverCatalog(AbortSignal.any([request.signal, AbortSignal.timeout(20000)]));
      if (modelRequest !== request) return;
      discoveredCapabilities = catalog.capabilities || {};
      syncModelEffort(selectedEffort());
      const levels = reportedModelEfforts();
      if (levels.length) modelResult(`已读取 ${levels.length} 个档位。`);
      else modelResult('服务未返回该模型的档位。可使用服务默认或自定义。', 'warning');
    } catch (error) {
      if (modelRequest === request) modelResult(error.message, 'danger');
    } finally {
      if (modelRequest === request) setModelRequest(null);
    }
  }
  function previewEndpoint(announce = false) {
    const preview = $('connection-endpoint-preview');
    const value = $('connection-base-url').value.trim();
    preview.hidden = !value;
    preview.textContent = '';
    if (!value) return;
    try {
      const baseUrl = normalizeApiBaseUrl(value);
      preview.textContent = `预览: ${inferenceEndpoint(baseUrl, $('connection-protocol').value)}`;
    } catch (error) {
      preview.hidden = true;
      if (announce) toast(error.message, 'warning', { key: 'form-validation' });
    }
  }
  function usesEnvironmentKey(connection) {
    return connection?.auth_mode === 'env' || (!config?.secret_storage_supported && connection?.auth_mode !== 'stored');
  }
  function syncFields() {
    const profile = $('connection-kind').value === 'profile';
    const existing = config?.connections.find(c => c.id === editingId);
    const envKey = usesEnvironmentKey(existing);
    $('endpoint-fields').hidden = profile; $('profile-fields').hidden = !profile;
    $('connection-base-url').required = !profile;
    $('connection-profile').required = profile;
    $('connection-profile').disabled = !profile;
    for (const field of $('endpoint-fields').querySelectorAll('input, select')) field.disabled = profile;
    $('stored-auth-field').hidden = envKey;
    $('env-auth-field').hidden = !envKey;
    if (profile || envKey) hideApiKey();
    $('connection-env-var').required = !profile && existing?.auth_mode === 'env';
    apiKeyInput.required = !profile && existing?.auth_mode === 'stored' && !existing.has_api_key;
    $('discover-models').hidden = profile;
    $('test-connection').textContent = profile ? '检查配置' : '测试连接';
    $('connection-test-hint').textContent = profile ? '此连接沿用已有 Codex 配置，检查不会调用模型。' : '连接测试使用默认模型及其思考设置，可能计入该服务的用量。';
    renderModels();
    selects.refresh();
    previewEndpoint();
  }
  function draft(selected = selection) {
    const existing = config?.connections.find(c => c.id === editingId);
    const kind = $('connection-kind').value === 'profile' ? 'profile' : existing?.kind || 'api';
    const envKey = usesEnvironmentKey(existing);
    const key = apiKeyInput.value.trim();
    const apiKey = kind !== 'profile' && !envKey && key !== revealedSavedKey ? key : '';
    const keyEnvironment = $('connection-env-var').value.trim();
    let authMode = 'none';
    if (kind !== 'profile') {
      if (envKey && (keyEnvironment || existing?.auth_mode === 'env')) authMode = 'env';
      else if (apiKey || existing?.auth_mode === 'stored') authMode = 'stored';
    }
    return {
      name: $('connection-name').value.trim(), kind,
      profile: $('connection-profile').value.trim(),
      protocol: $('connection-protocol').value, base_url: $('connection-base-url').value.trim(),
      auth_mode: authMode, api_key: apiKey,
      api_key_env: keyEnvironment,
      auth_header: existing?.auth_header || 'Authorization',
      ...selected.snapshot(),
      context_window: existing?.context_window,
      reasoning_effort: existing?.reasoning_effort,
      thinking_format: existing?.thinking_format,
      thinking_mode: existing?.thinking_mode,
      thinking_budget: existing?.thinking_budget,
      enabled: existing?.enabled !== false,
    };
  }
  function signature() {
    const input = draft(); const normalized = normalizeReasoning(input);
    delete input.enabled;
    for (const field of ['reasoning_effort', 'thinking_format', 'thinking_mode', 'thinking_budget']) delete input[field];
    input.model_reasoning = Object.fromEntries(Object.entries(input.model_reasoning).sort(([a], [b]) => a.localeCompare(b)).map(([model, settings]) => [model, normalizeReasoning(settings)]));
    return JSON.stringify({ ...input, ...normalized });
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
    $('connection-protocol').value = connection?.protocol === 'chat_completions' ? 'chat_completions' : 'responses';
    $('connection-base-url').value = connection?.base_url || '';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = connection?.has_api_key ? '········' : '可留空';
    $('connection-env-var').value = connection?.api_key_env || '';
    selection = new ModelSelection(connection || {});
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
      const current = editingId === (connection?.id || null);
      const expanded = editorOpen && current;
      const enabled = connection?.enabled !== false;
      const isDefault = connection?.id === config.default_connection_id;
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
      if (isDefault) heading.append(el('span', 'default-badge', '默认'));
      const actions = el('div', 'connection-row-actions');
      if (connection && !isDefault) {
        const button = el('button', 'set-default-button', '设为默认连接'); button.type = 'button'; button.disabled = !enabled;
        button.addEventListener('click', async () => {
          if (busy) return;
          busyState(true);
          try {
            config = await api('/api/config/default', { method: 'PATCH', ...payload({ connection_id: connection.id, model: connection.default_model }) });
            renderCards();
            toast('新任务将使用所选连接');
            onSaved(config);
          } catch (error) {
            toast(error.message, 'danger');
          } finally {
            busyState(false);
          }
        }); actions.append(button);
      }
      if (connection) {
        const enableSwitch = el('button', 'connection-enable-switch');
        enableSwitch.id = `connection-enable-${id}`;
        enableSwitch.type = 'button';
        enableSwitch.setAttribute('role', 'switch');
        enableSwitch.setAttribute('aria-label', `启用 ${name}`);
        enableSwitch.setAttribute('aria-checked', String(enabled));
        enableSwitch.disabled = isDefault && enabled;
        enableSwitch.title = enableSwitch.disabled ? '请先切换默认连接' : enabled ? '停用连接' : '启用连接';
        enableSwitch.addEventListener('click', async () => {
          if (busy || enableSwitch.disabled) return;
          busyState(true);
          enableSwitch.disabled = true;
          try {
            config = await api(`/api/config/connections/${id}`, {
              method: 'PATCH',
              ...payload({ enabled: !enabled }),
            });
            renderCards();
            $(`connection-enable-${id}`)?.focus();
            onSaved(config);
          } catch (error) {
            toast(error.message, 'danger');
          } finally {
            enableSwitch.disabled = false;
            busyState(false);
          }
        });
        actions.append(enableSwitch);
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
    if (!modelsOf().length) {
      result('请至少添加一个模型。', 'warning');
      $('add-model').focus();
      return;
    }
    busyState(true); result();
    try {
      const input = draft(); const previousId = editingId;
      config = await api(previousId ? `/api/config/connections/${previousId}` : '/api/config/connections', { method: previousId ? 'PUT' : 'POST', ...payload(input) });
      const saved = previousId ? config.connections.find(c => c.id === previousId) : config.connections.at(-1);
      populate(saved); toast('模型连接已保存'); onSaved(config);
    } catch (error) { result(error.message, 'danger'); }
    finally { busyState(false); }
  }
  async function testConnection() {
    if (busy || !editingId) return;
    try { if (signature() !== savedSignature) throw new Error(); } catch { result('有未保存的修改，请先保存后再测试。', 'warning'); return; }
    busyState(true); result('正在检查已保存的连接…', 'info', true);
    try {
      const check = await api(`/api/config/connections/${editingId}/test`, { method: 'POST', ...payload({ model: selection.defaultModel }) });
      result(`${check.message}${check.latency_ms ? ` 耗时 ${(check.latency_ms / 1000).toFixed(1)} 秒。` : ''}`, check.tool_calling === false ? 'warning' : 'info');
    } catch (error) { result(error.message, 'danger'); } finally { busyState(false); }
  }
  $('connection-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  $('test-connection').addEventListener('click', () => { void testConnection(); });
  $('new-connection').addEventListener('click', () => { if (!busy) { if (initialized && !editingId) { editorOpen = true; renderCards(); } else populate(); $('connection-name').focus(); } });
  $('add-model').addEventListener('click', () => openModelDialog());
  $('close-model-dialog').addEventListener('click', closeModelDialog);
  $('cancel-model-dialog').addEventListener('click', closeModelDialog);
  modelDialog.addEventListener('close', () => {
    if (!modelDialog.open) closeModelDialog();
  });
  $('model-effort-set').addEventListener('change', () => {
    modelResult();
    syncModelEffort('');
    announceMissingEfforts();
  });
  $('model-id-input').addEventListener('input', () => syncModelEffort(selectedEffort()));
  $('test-model-draft').addEventListener('click', testModelDraft);
  $('read-model-efforts').addEventListener('click', readModelEfforts);
  $('model-dialog-form').addEventListener('submit', event => {
    event.preventDefault();
    if (modelRequest || !$('model-dialog-form').reportValidity()) return;
    try {
      selection = readModelDraft().candidate;
      closeModelDialog();
      renderModels();
    } catch (error) {
      modelResult(error.message, 'warning');
    }
  });
  $('connection-protocol').addEventListener('input', () => previewEndpoint());
  $('connection-base-url').addEventListener('input', () => previewEndpoint());
  $('connection-base-url').addEventListener('blur', () => previewEndpoint(true));
  $('connection-kind').addEventListener('change', syncFields);
  apiKeyToggle.addEventListener('click', toggleApiKey);
  function discoverCatalog(signal) {
    const input = draft();
    if (!input.name) input.name = '未命名连接';
    return api('/api/config/discover', {
      method: 'POST',
      ...payload({ connection: input, connection_id: editingId }),
      signal,
    });
  }
  async function inspectService(loadModels) {
    if (busy) return;
    busyState(true);
    result(loadModels ? '正在读取模型列表…' : '正在检查服务…', 'info', true);
    try {
      const discovered = await discoverCatalog();
      discoveredCapabilities = discovered.capabilities || {};
      if (loadModels) {
        discoveredModels = discovered.models;
        renderModels();
        result(`已读取 ${discovered.models.length} 个模型。点击候选项右侧的加号添加。`);
      } else {
        result(`服务连接正常，模型列表返回 ${discovered.models.length} 项。`);
      }
    } catch (error) {
      result(error.message, 'danger');
    } finally {
      busyState(false);
    }
  }
  $('discover-models').addEventListener('click', () => inspectService(true));
  $('check-api-service').addEventListener('click', () => inspectService(false));
  $('export-connection').addEventListener('click', async () => {
    if (!editingId || busy) return;
    $('connection-more').open = false;
    busyState(true);
    try {
      exported = await api(`/api/config/connections/${editingId}/export-profile`, { method: 'POST' });
      for (const field of ['note', 'target', 'content', 'launch']) $(`export-profile-${field}`).textContent = exported[field];
      $('export-profile-dialog').showModal();
    } catch (error) { toast(error.message, 'danger'); }
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
    try { config = await api(`/api/config/connections/${pendingDelete}`, { method: 'DELETE' }); pendingDelete = null; $('delete-connection-dialog').close(); populate(config.connections.find(c => c.id === config.default_connection_id), false); toast('连接已移除'); onSaved(config); } catch (error) { toast(error.message, 'danger'); }
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
        toast('', 'info', { key: 'settings-load' });
        if (initialized && !editingId) {
          renderCards();
        } else {
          const connection = config.connections.find(c => c.id === editingId)
            || config.connections.find(c => c.id === config.default_connection_id);
          populate(connection, editorOpen);
        }
      } catch (error) {
        toast(error.message, 'danger', { key: 'settings-load', persistent: true });
      }
    },
    hide() {
      toast('', 'info', { key: 'settings-load' });
      result();
      selects.close();
      closeModelDialog();
      hideApiKey();
      $('settings-page').hidden = true;
      $('new-connection').hidden = true;
    },
  };
}
