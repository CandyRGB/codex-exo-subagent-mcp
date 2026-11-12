import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeReasoning } from './reasoning.mjs';
import { normalizeApiBaseUrl } from './api-endpoint.mjs';

const validId = /^[a-zA-Z0-9_-]{1,80}$/;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const writeJSON = (path, value) => { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, path); };
const text = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n\0]/.test(value);

export class WindowsSecretCodec {
  constructor() { this.supported = process.platform === 'win32'; }
  transform(value, decrypt) {
    if (!this.supported) throw new Error('当前系统请使用环境变量认证；API Key 本地加密保存需要 Windows。');
    const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes("Subagent model vault v1"); if($env:SUBAGENT_SECRET_OPERATION -eq "decrypt"){$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Out.Write([Convert]::ToBase64String($result))';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: decrypt ? value : Buffer.from(value, 'utf8').toString('base64'), encoding: 'utf8',
      env: { ...process.env, SUBAGENT_SECRET_OPERATION: decrypt ? 'decrypt' : 'encrypt' }, windowsHide: true, timeout: 15000,
    });
    if (result.error || result.status !== 0) throw new Error('无法访问当前 Windows 用户的加密凭据。请重新保存 API Key，或改用环境变量。');
    return decrypt ? Buffer.from(result.stdout.trim(), 'base64').toString('utf8') : result.stdout.trim();
  }
  protect(value) { return this.transform(value, false); }
  unprotect(value) { return this.transform(value, true); }
}

export class ModelStore {
  constructor({ stateDir, env = process.env, codec = new WindowsSecretCodec() }) {
    this.stateDir = resolve(stateDir); this.env = env; this.codec = codec;
    this.root = join(this.stateDir, 'config'); mkdirSync(this.root, { recursive: true });
    this.path = join(this.root, 'models.json'); this.secretsPath = join(this.root, 'credentials.json');
    this.tokenPath = join(this.root, 'gateway.token'); this.secretCache = new Map();
  }
  read() {
    let raw;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, default_connection_id: null, connections: [] };
      throw error;
    }
    const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (config.version !== 1 || !Array.isArray(config.connections)) throw new Error('模型配置格式无效，请从备份恢复。');
    return config;
  }
  credentials() { try { return JSON.parse(readFileSync(this.secretsPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('加密凭据文件无法读取。'); } }
  get(id) {
    if (!validId.test(id || '')) fail('连接编号无效。');
    const connection = this.read().connections.find(item => item.id === id);
    if (!connection) throw Object.assign(new Error('模型连接不存在，请重新选择。'), { status: 404 });
    return connection;
  }
  publicConfig() {
    const config = this.read(); const secrets = this.credentials();
    const fields = ['id', 'name', 'kind', 'protocol', 'profile', 'base_url', 'models', 'default_model', 'auth_mode', 'auth_header', 'api_key_env', 'context_window', 'reasoning_effort', 'thinking_mode', 'thinking_budget', 'thinking_format', 'model_reasoning', 'model_limits', 'enabled'];
    return { version: config.version, default_connection_id: config.default_connection_id, secret_storage_supported: this.codec.supported, connections: config.connections.map(c => ({ ...Object.fromEntries(fields.filter(field => c[field] !== undefined).map(field => [field, c[field]])), has_api_key: Boolean(secrets[c.id]) })) };
  }
  normalize(input, previous = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('连接配置必须是对象。');
    if (!text(input.name, 80)) fail('请填写连接名称，最多 80 个字符。');
    const kind = input.kind || 'api';
    if (!['local', 'api', 'router', 'profile'].includes(kind)) fail('请选择有效的接入方式。');
    const models = [...new Set((Array.isArray(input.models) ? input.models : String(input.models || '').split(/[\r\n]+/)).map(m => String(m).trim()).filter(Boolean))];
    if (!models.length || models.length > 100 || models.some(model => !text(model) || /\s/.test(model))) fail('请配置 1–100 个模型 ID，每行一个，不包含空格。');
    const defaultModel = input.default_model || models[0];
    if (!models.includes(defaultModel)) fail('默认模型必须在已配置的模型列表中。');
    const connection = { id: previous?.id || `conn-${randomUUID().slice(0, 8)}`, name: input.name.trim(), kind, enabled: input.enabled !== false, models, default_model: defaultModel };
    if (kind === 'profile') {
      const profile = input.profile ?? previous?.profile;
      if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(profile)) fail('请填写已有 Codex profile 名称，只能包含字母、数字、短横线和下划线。');
      connection.protocol = 'profile'; connection.profile = profile; connection.auth_mode = 'none';
      return connection;
    }
    if (!['responses', 'chat_completions'].includes(input.protocol)) fail('请选择 Responses 或 Chat Completions 协议。');
    connection.base_url = normalizeApiBaseUrl(input.base_url);
    connection.protocol = input.protocol;
    connection.auth_mode = input.auth_mode || 'none';
    if (!['none', 'env', 'stored'].includes(connection.auth_mode)) fail('请选择有效的认证方式。');
    connection.auth_header = input.auth_header?.trim() || 'Authorization';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(connection.auth_header) || /^(host|cookie|content-length|content-type|origin|x-subagent-route-hash)$/i.test(connection.auth_header)) fail('认证请求头名称无效。');
    if (connection.auth_mode === 'env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.api_key_env || '')) fail('请填写有效的环境变量名称。');
      connection.api_key_env = input.api_key_env;
    }
    if (input.context_window !== undefined && input.context_window !== null && input.context_window !== '') {
      const value = Number(input.context_window);
      if (!Number.isInteger(value) || value < 2048 || value > 4_000_000) fail('上下文窗口必须在 2048–4000000 token 之间。');
      connection.context_window = value;
    }
    Object.assign(connection, normalizeReasoning(input));
    if (input.model_limits !== undefined) {
      if (!input.model_limits || typeof input.model_limits !== 'object' || Array.isArray(input.model_limits)) fail('模型参数必须是对象。');
      const limits = [];
      for (const [model, fields] of Object.entries(input.model_limits)) {
        if (!models.includes(model) || !fields || typeof fields !== 'object' || Array.isArray(fields)) fail('模型参数只能用于当前模型列表。');
        const values = {};
        for (const [field, minimum, label] of [['context_window', 2048, '上下文窗口'], ['max_output_tokens', 1, '最大输出 Token 数']]) {
          const value = fields[field];
          if (value === undefined) continue;
          if (!Number.isInteger(value) || value < minimum || value > 4_000_000) fail(`${label}必须是 ${minimum}–4000000 的整数。`);
          values[field] = value;
        }
        if (Object.keys(values).length) limits.push([model, values]);
      }
      if (limits.length) connection.model_limits = Object.fromEntries(limits);
    }
    if (input.model_reasoning !== undefined) {
      if (!input.model_reasoning || typeof input.model_reasoning !== 'object' || Array.isArray(input.model_reasoning)) fail('模型独立思考设置必须是对象。');
      const entries = Object.entries(input.model_reasoning);
      if (entries.length > 100 || entries.some(([model]) => !models.includes(model))) fail('独立思考设置只能用于当前模型列表中的模型。');
      connection.model_reasoning = Object.fromEntries(entries.map(([model, settings]) => [model, normalizeReasoning(settings)]));
    }
    return connection;
  }
  save(input, id = null) {
    const config = this.read(); const previous = id ? this.get(id) : null;
    if (!previous && config.connections.length >= 50) fail('最多保存 50 个模型连接。');
    const connection = this.normalize(input, previous);
    if (!connection.enabled && config.default_connection_id === connection.id) {
      clearDefault(config, connection.id, '停用');
    }
    const credentials = this.credentials();
    if (connection.auth_mode === 'stored') {
      if (input.api_key) {
        if (!text(input.api_key, 8192)) fail('API Key 格式无效。');
        credentials[connection.id] = this.codec.protect(input.api_key.trim());
      } else if (!credentials[connection.id]) fail('请填写 API Key。');
    } else delete credentials[connection.id];
    this.secretCache.delete(connection.id);
    writeJSON(this.secretsPath, credentials);
    if (previous) config.connections[config.connections.findIndex(c => c.id === id)] = connection;
    else config.connections.push(connection);
    if (connection.enabled && !config.default_connection_id) config.default_connection_id = connection.id;
    writeJSON(this.path, config);
    return this.publicConfig();
  }
  setDefault(id, model) {
    const config = this.read(); const connection = config.connections.find(c => c.id === id);
    if (!connection?.enabled) fail('请选择已启用的连接。');
    if (!connection.models.includes(model)) fail('默认模型必须在连接的模型列表中。');
    connection.default_model = model; config.default_connection_id = id; writeJSON(this.path, config);
    return this.publicConfig();
  }
  setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') fail('连接状态必须是布尔值。');
    const config = this.read();
    const connection = config.connections.find(item => item.id === id);
    if (!connection) throw Object.assign(new Error('模型连接不存在，请重新选择。'), { status: 404 });
    if (!enabled && config.default_connection_id === id) clearDefault(config, id, '停用');
    connection.enabled = enabled;
    if (enabled && !config.default_connection_id) config.default_connection_id = id;
    writeJSON(this.path, config);
    return this.publicConfig();
  }
  remove(id) {
    const config = this.read(); this.get(id);
    if (config.default_connection_id === id) clearDefault(config, id, '移除');
    config.connections = config.connections.filter(c => c.id !== id);
    const credentials = this.credentials(); delete credentials[id]; writeJSON(this.secretsPath, credentials);
    this.secretCache.delete(id); writeJSON(this.path, config); return this.publicConfig();
  }
  secret(connection) {
    if (connection.auth_mode === 'none') return '';
    if (connection.auth_mode === 'env') {
      const value = this.env[connection.api_key_env];
      if (!value || /[\r\n]/.test(value)) throw new Error(`服务进程未读取到环境变量 ${connection.api_key_env}。设置后请重启本地服务。`);
      return value;
    }
    const encrypted = this.credentials()[connection.id];
    if (!encrypted) throw new Error('API Key 尚未保存，请在模型设置中填写。');
    const cached = this.secretCache.get(connection.id);
    if (cached?.encrypted === encrypted) return cached.value;
    const value = this.codec.unprotect(encrypted); this.secretCache.set(connection.id, { encrypted, value }); return value;
  }
  headers(connection) {
    const secret = this.secret(connection);
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers[connection.auth_header || 'Authorization'] = /^Authorization$/i.test(connection.auth_header || '') ? `Bearer ${secret}` : secret;
    return { headers, secret };
  }
  fingerprint(connection) {
    return createHash('sha256').update(JSON.stringify([connection.id, connection.kind, connection.profile, connection.protocol, connection.base_url, connection.auth_mode, connection.api_key_env, connection.auth_header])).digest('hex');
  }
  select(args, parent = null) {
    if (args.connection_id && args.profile) fail('connection_id 和 profile 不能同时指定。');
    if (parent && !parent.connection_id) return { connection: null, model: parent.model, profile: parent.profile };
    if (!parent && args.profile) return { connection: null, model: args.model || this.env.CODEX_SUBAGENT_MODEL || null, profile: args.profile };
    const config = this.read();
    const id = parent?.connection_id || args.connection_id || config.default_connection_id;
    if (!id) {
      const profile = this.env.CODEX_SUBAGENT_PROFILE;
      if (profile) return { connection: null, model: args.model || this.env.CODEX_SUBAGENT_MODEL || null, profile };
      fail('尚未配置默认模型连接。请在「模型与连接」中添加并启用连接。');
    }
    const connection = this.get(id);
    if (!connection.enabled) throw new Error('所选模型连接已停用。');
    if (parent && (args.connection_id && args.connection_id !== parent.connection_id || parent.connection_fingerprint !== this.fingerprint(connection))) throw new Error('续聊连接的地址或认证方式已改变，请恢复原配置或新建任务。');
    return { connection, model: parent?.model || args.model || connection.default_model, profile: connection.kind === 'profile' ? connection.profile : null };
  }
  gatewayToken() {
    try { return readFileSync(this.tokenPath, 'utf8').trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const token = randomBytes(32).toString('base64url');
      try { writeFileSync(this.tokenPath, token, { flag: 'wx', mode: 0o600 }); return token; }
      catch (e) { if (e.code === 'EEXIST') return readFileSync(this.tokenPath, 'utf8').trim(); throw e; }
    }
  }
  describe(id = null) {
    const config = this.read(); const selected = config.connections.find(c => c.id === config.default_connection_id);
    return { default_connection_id: config.default_connection_id, default_model: selected?.default_model ?? null,
      connections: config.connections.filter(c => c.enabled && (!id || c.id === id)).map(c => ({ id: c.id, name: c.name, kind: c.kind, protocol: c.protocol, default_model: c.default_model, models: c.models.slice(0, id ? 100 : 10), more_models: Math.max(0, c.models.length - (id ? 100 : 10)) })) };
  }
}

function clearDefault(config, id, action) {
  if (config.connections.some(c => c.id !== id && c.enabled)) fail(`请先切换默认连接，再${action}此连接。`);
  config.default_connection_id = null;
}

export function safeError(message, secret = '') {
  let value = String(message || '请求失败');
  if (secret) value = value.split(secret).join('<REDACTED>');
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer <REDACTED>').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<REDACTED>').slice(0, 1200);
}
