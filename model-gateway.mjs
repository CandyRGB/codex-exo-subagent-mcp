import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { safeError } from './model-store.mjs';

export async function readJSON(request, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求内容过大。'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效。'), { status: 400 }); }
}

export async function* sseJSON(body) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch {}
    }
    if (buffer.length > 8_000_000) throw new Error('上游流式响应中的单条事件过大。');
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch {} }
  }
}

function toolMap(tools = []) {
  const list = []; const byAlias = new Map(); const byName = new Map();
  function add(tool, namespace = '') {
    if (tool.type === 'namespace') { for (const child of tool.tools || []) add(child, tool.name); return; }
    if (!['function', 'custom'].includes(tool.type)) return;
    const alias = `${namespace ? namespace + '_' : ''}${tool.name}`.replace(/[^\w-]/g, '_').slice(0, 54) + '_' + createHash('sha256').update(`${namespace}.${tool.name}`).digest('hex').slice(0, 6);
    const spec = { alias, name: tool.name, namespace, custom: tool.type === 'custom' };
    const parameters = spec.custom ? { type: 'object', properties: { input: { type: 'string', description: 'The exact raw input required by this tool.' } }, required: ['input'], additionalProperties: false } : tool.parameters || { type: 'object', properties: {} };
    list.push({ type: 'function', function: { name: alias, description: (tool.description || '').slice(0, 20000), parameters } });
    byAlias.set(alias, spec); byName.set(`${namespace}.${tool.name}`, spec);
    if (!byName.has(tool.name)) byName.set(tool.name, spec);
  }
  tools.forEach(tool => add(tool));
  return { list, byAlias, byName };
}

function chatContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const part of content || []) {
    if (['input_text', 'output_text', 'text'].includes(part.type)) parts.push({ type: 'text', text: part.text || '' });
    else if (part.type === 'input_image') parts.push({ type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } });
    else if (part.type === 'image_url') parts.push(part);
  }
  return parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts;
}

export function responsesToChat(body, cachedMessages = []) {
  const tools = toolMap(body.tools);
  const messages = cachedMessages.map(message => ({ ...message }));
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
  for (const item of input) {
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const spec = tools.byName.get(`${item.namespace || ''}.${item.name}`) || tools.byName.get(item.name);
      if (!spec) throw new Error(`无法映射历史工具调用：${item.name}`);
      const call = { id: item.call_id, type: 'function', function: { name: spec.alias, arguments: spec.custom ? JSON.stringify({ input: item.input || '' }) : item.arguments || '{}' } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls = [...last.tool_calls, call];
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
    } else if (item.role) {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (['system', 'user', 'assistant', 'tool'].includes(role)) messages.push({ role, content: chatContent(item.content) });
    } else if (item.type === 'item_reference') throw new Error('此连接需要完整的历史消息，暂不支持独立 item_reference。');
  }
  const merged = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (message.role === 'system' && last?.role === 'system' && typeof last.content === 'string' && typeof message.content === 'string') last.content += '\n\n' + message.content;
    else merged.push(message);
  }
  const request = { model: body.model, messages: merged, stream: true, stream_options: { include_usage: true } };
  if (tools.list.length) {
    request.tools = tools.list;
    if (typeof body.tool_choice === 'string') request.tool_choice = body.tool_choice;
    else if (body.tool_choice?.name) {
      const spec = tools.byName.get(`${body.tool_choice.namespace || ''}.${body.tool_choice.name}`) || tools.byName.get(body.tool_choice.name);
      if (spec) request.tool_choice = { type: 'function', function: { name: spec.alias } };
    }
    if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (Number.isFinite(body.max_output_tokens)) request.max_tokens = body.max_output_tokens;
  if (Number.isFinite(body.temperature)) request.temperature = body.temperature;
  if (body.text?.format?.type === 'json_schema') request.response_format = { type: 'json_schema', json_schema: { name: body.text.format.name || 'response', schema: body.text.format.schema, strict: body.text.format.strict ?? true } };
  if (body.text?.format?.type === 'json_object') request.response_format = { type: 'json_object' };
  return { request, tools };
}

const usageOf = usage => ({ input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0, total_tokens: usage?.total_tokens || (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0), input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens || 0 } });

export class ModelGateway {
  constructor({ store, baseUrl }) { this.store = store; this.baseUrl = baseUrl; this.cache = new Map(); }

  async discover(input, id = null) {
    const previous = id ? this.store.get(id) : null;
    const connection = this.store.normalize({ ...input, models: Array.isArray(input.models) && input.models.length ? input.models : ['discovery-placeholder'] }, previous);
    if (connection.kind === 'profile') throw Object.assign(new Error('已有 Codex 配置的模型请手动填写。'), { status: 400 });
    const keyOverride = connection.auth_mode === 'stored' ? input.api_key : '';
    if (keyOverride && (typeof keyOverride !== 'string' || keyOverride.length > 8192 || /[\r\n]/.test(keyOverride))) throw Object.assign(new Error('API Key 格式无效。'), { status: 400 });
    const secret = keyOverride || this.store.secret(connection);
    const headers = secret ? { [connection.auth_header]: /^authorization$/i.test(connection.auth_header) ? `Bearer ${secret}` : secret } : {};
    try {
      const response = await fetch(connection.base_url + '/models', { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`模型列表请求失败 (${response.status})；此服务可能需要手动填写模型 ID。`);
      const data = await response.json();
      const models = [...new Set((data.data || data.models || []).map(model => typeof model === 'string' ? model : model.id || model.name).filter(model => typeof model === 'string'))].slice(0, 2000).sort();
      return { models };
    } catch (error) { throw Object.assign(new Error(safeError(error.message, secret)), { status: 400 }); }
  }

  async probe(id, model) {
    const connection = this.store.get(id);
    if (connection.kind === 'profile') return { ok: true, level: 'profile', tool_calling: null, message: '此连接沿用现有 Codex 配置；模型可用性请通过实际任务验证。' };
    const started = Date.now();
    const response = await fetch(`${this.baseUrl()}/inference/${id}/v1/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.store.gatewayToken()}`, 'X-Subagent-Route-Hash': this.store.fingerprint(connection) },
      body: JSON.stringify({ model: model || connection.default_model, stream: true, input: [{ role: 'user', content: 'Call subagent_connection_probe with ok=true. Do not do anything else.' }], max_output_tokens: 128, tools: [{ type: 'function', name: 'subagent_connection_probe', description: 'Check the connection.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }], tool_choice: { type: 'function', name: 'subagent_connection_probe' } }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw Object.assign(new Error(error.error?.message || `连接测试失败 (${response.status})`), { status: 400 }); }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw Object.assign(new Error('接口未提供 Codex 需要的流式 Responses 响应。'), { status: 400 });
    let completed = false, tool = false;
    for await (const event of sseJSON(response.body)) {
      if (event.type === 'error' || event.type === 'response.failed') throw Object.assign(new Error(event.message || event.response?.error?.message || '模型流式响应失败。'), { status: 400 });
      if (event.type === 'response.completed') {
        completed = true;
        const call = event.response?.output?.find(item => item.type === 'function_call' && item.name === 'subagent_connection_probe');
        try { tool = Boolean(call && JSON.parse(call.arguments).ok === true); } catch { tool = false; }
      }
    }
    if (!completed) throw Object.assign(new Error('流式响应未正常结束，当前接口尚未通过兼容性测试。'), { status: 400 });
    return { ok: true, streaming: true, tool_calling: tool, latency_ms: Date.now() - started, message: tool ? '连接、流式响应和工具调用测试通过。' : '连接和流式响应通过；模型未按要求调用工具，代理任务兼容性尚未确认。' };
  }

  async handle(request, response, id) {
    const expected = `Bearer ${this.store.gatewayToken()}`;
    const received = request.headers.authorization || '';
    if (received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Local gateway authentication required.' } })); return;
    }
    let secret = '';
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const connection = this.store.get(id);
      if (!connection.enabled || connection.kind === 'profile') throw Object.assign(new Error('该连接无法通过本机模型网关使用。'), { status: 400 });
      if (request.headers['x-subagent-route-hash'] !== this.store.fingerprint(connection)) throw Object.assign(new Error('连接配置已经改变，请新建任务。'), { status: 409 });
      const body = await readJSON(request, 64_000_000);
      const auth = this.store.headers(connection); secret = auth.secret;
      if (connection.protocol === 'responses') {
        const upstream = await fetch(connection.base_url + '/responses', { method: 'POST', headers: auth.headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
        if (!upstream.ok) { const error = await upstream.text(); throw Object.assign(new Error(`上游接口 ${upstream.status}: ${error.slice(0, 2000)}`), { status: upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502 }); }
        response.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        for await (const chunk of upstream.body) { if (!response.write(chunk)) await once(response, 'drain'); }
        response.end();
      } else await this.chat(connection, body, response, auth.headers, controller.signal);
    } catch (error) {
      const message = safeError(error.message, secret);
      if (!response.headersSent) { response.writeHead(error.status || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: { type: 'model_connection_error', message } })); }
      else if (!response.writableEnded && !response.destroyed) { response.end(`event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`); }
    }
  }

  async chat(connection, body, response, headers, signal) {
    const cached = body.previous_response_id && this.cache.get(body.previous_response_id);
    if (body.previous_response_id && (!cached || cached.fingerprint !== this.store.fingerprint(connection))) throw new Error('找不到 previous_response_id 的上下文，请重试并发送完整历史。');
    const { request, tools } = responsesToChat(body, cached?.messages || []);
    if (connection.reasoning_effort) request.reasoning_effort = connection.reasoning_effort;
    const send = () => fetch(connection.base_url + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(request), redirect: 'error', signal });
    let upstream = await send();
    if (!upstream.ok) {
      const error = await upstream.text();
      if (upstream.status === 400 && /stream_options/i.test(error)) { delete request.stream_options; upstream = await send(); }
      else throw Object.assign(new Error(`上游接口 ${upstream.status}: ${error.slice(0, 2000)}`), { status: upstream.status });
    }
    if (!upstream.ok) throw Object.assign(new Error(`上游接口 ${upstream.status}: ${(await upstream.text()).slice(0, 2000)}`), { status: upstream.status });
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const id = 'resp_' + randomUUID().replaceAll('-', ''); const created = Math.floor(Date.now() / 1000);
    let sequence = 0;
    const emit = async (type, value) => { if (response.destroyed) throw new Error('Client disconnected'); if (!response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`)) await once(response, 'drain'); };
    const envelope = { id, object: 'response', created_at: created, status: 'in_progress', model: body.model, output: [], error: null, incomplete_details: null };
    await emit('response.created', { response: envelope });
    const output = []; const calls = new Map(); let message = null, usage = null, finishReason = null;
    const ensureCall = async call => {
      if (call.item || !tools.byAlias.has(call.name)) return;
      const spec = tools.byAlias.get(call.name); call.spec = spec; call.index = output.length;
      call.item = { id: (spec.custom ? 'ctc_' : 'fc_') + randomUUID().replaceAll('-', ''), type: spec.custom ? 'custom_tool_call' : 'function_call', call_id: call.id || 'call_' + randomUUID().replaceAll('-', ''), name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), status: 'in_progress', ...(spec.custom ? { input: '' } : { arguments: '' }) };
      output.push(call.item); await emit('response.output_item.added', { output_index: call.index, item: { ...call.item } });
      if (!spec.custom && call.arguments) { call.item.arguments = call.arguments; await emit('response.function_call_arguments.delta', { output_index: call.index, item_id: call.item.id, delta: call.arguments }); }
    };
    const consume = async chunk => {
      if (chunk.error) throw new Error(chunk.error.message || '上游模型返回错误。');
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0]; if (!choice) return;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string' && delta.content) {
        if (!message) {
          message = { id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [] }] };
          message.index = output.length; output.push(message);
          await emit('response.output_item.added', { output_index: message.index, item: { ...message, content: [] } });
          await emit('response.content_part.added', { output_index: message.index, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        message.content[0].text += delta.content;
        await emit('response.output_text.delta', { output_index: message.index, item_id: message.id, content_index: 0, delta: delta.content });
      }
      for (const value of delta.tool_calls || []) {
        const key = value.index ?? 0;
        let call = calls.get(key);
        if (!call) { call = { name: '', arguments: '', id: value.id || null, item: null }; calls.set(key, call); }
        if (value.id && !call.item) call.id = value.id;
        if (value.function?.name) call.name += value.function.name;
        const args = value.function?.arguments || '';
        call.arguments += args;
        const alreadyAdded = Boolean(call.item); await ensureCall(call);
        if (alreadyAdded && args && !call.spec.custom) { call.item.arguments += args; await emit('response.function_call_arguments.delta', { output_index: call.index, item_id: call.item.id, delta: args }); }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    if (upstream.headers.get('content-type')?.includes('text/event-stream')) { for await (const chunk of sseJSON(upstream.body)) await consume(chunk); }
    else await consume(await upstream.json());
    if (!finishReason) throw new Error('Chat Completions 流未正常结束，未收到 finish_reason。');
    if (message) {
      message.status = 'completed';
      await emit('response.output_text.done', { output_index: message.index, item_id: message.id, content_index: 0, text: message.content[0].text });
      await emit('response.content_part.done', { output_index: message.index, item_id: message.id, content_index: 0, part: message.content[0] });
      await emit('response.output_item.done', { output_index: message.index, item: message });
    }
    for (const call of calls.values()) {
      if (!call.item) throw new Error(`模型返回了未知工具：${call.name}`);
      call.item.status = 'completed';
      if (call.spec.custom) {
        let input; try { input = JSON.parse(call.arguments).input; } catch { throw new Error('模型返回的自定义工具输入不是有效 JSON。'); }
        if (typeof input !== 'string') throw new Error('自定义工具缺少 input 字符串。');
        call.item.input = input;
        await emit('response.custom_tool_call_input.delta', { output_index: call.index, item_id: call.item.id, delta: input });
        await emit('response.custom_tool_call_input.done', { output_index: call.index, item_id: call.item.id, input });
      } else await emit('response.function_call_arguments.done', { output_index: call.index, item_id: call.item.id, name: call.item.name, arguments: call.item.arguments });
      await emit('response.output_item.done', { output_index: call.index, item: call.item });
    }
    if (!output.length) throw new Error('模型没有返回文本或工具调用。');
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const final = { ...envelope, status, output: output.map(({ index, ...item }) => item), usage: usageOf(usage), incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null };
    await emit(status === 'completed' ? 'response.completed' : 'response.incomplete', { response: final });
    const followup = [...request.messages];
    const assistant = { role: 'assistant', content: message?.content[0].text || null };
    if (calls.size) assistant.tool_calls = [...calls.values()].map(call => ({ id: call.item.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    followup.push(assistant);
    const bytes = JSON.stringify(followup).length * 2;
    if (bytes < 4_000_000) this.cache.set(id, { fingerprint: this.store.fingerprint(connection), messages: followup, bytes });
    while (this.cache.size > 32 || [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 16_000_000) this.cache.delete(this.cache.keys().next().value);
    response.end();
  }
}
