const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const rawValue = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value);

export const reasoningEffortSets = {
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: ['none', 'low', 'high', 'max'],
};

export function normalizeReasoning(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('思考设置必须是对象。');
  const settings = {};
  const effortSet = input.effort_set;
  if (effortSet !== undefined) {
    if (typeof effortSet !== 'string' || (effortSet !== 'provider' && !Object.hasOwn(reasoningEffortSets, effortSet))) fail('思考档位方案无效。');
    settings.effort_set = effortSet;
  }
  const format = input.thinking_format || 'effort';
  if (!['effort', 'thinking', 'reasoning'].includes(format)) fail('思考参数结构无效。');
  if (format !== 'effort') settings.thinking_format = format;
  for (const field of ['reasoning_effort', 'thinking_mode']) {
    const value = input[field];
    if (value !== undefined && value !== null && value !== '') {
      if (!rawValue(value)) fail('思考强度和模式请填写 1–64 个字母、数字或 . _ : - 字符。');
      settings[field] = value;
    }
  }
  if (input.thinking_budget !== undefined && input.thinking_budget !== null && input.thinking_budget !== '') {
    if (!['number', 'string'].includes(typeof input.thinking_budget) || typeof input.thinking_budget === 'string' && !/^\d+$/.test(input.thinking_budget)) fail('思考预算必须是整数。');
    const value = Number(input.thinking_budget);
    if (!Number.isInteger(value) || value < 0 || value > 4_000_000) fail('思考预算必须是 0–4000000 的整数。');
    settings.thinking_budget = value;
  }
  const { reasoning_effort: effort, thinking_mode: mode, thinking_budget: budget } = settings;
  if (mode && format !== 'thinking' && !['enabled', 'disabled'].includes(mode)) fail('自适应等模式需使用支持 thinking 对象的兼容接口。');
  if (format === 'effort' && budget !== undefined) fail('标准 effort 没有通用预算字段；请使用服务支持的兼容扩展结构。');
  if (format === 'effort' && mode === 'enabled' && !effort) fail('标准 effort 开启思考时请填写具体强度，或留空模式以使用服务默认值。');
  if (mode === 'enabled' && effort === 'none') fail('开启思考与 none 强度冲突。');
  if (mode === 'disabled' && (effort && effort !== 'none' || budget > 0)) fail('关闭思考时请清空强度和预算，或使用 none 强度。');
  if (format === 'reasoning' && effort && budget !== undefined) fail('reasoning 兼容扩展请在强度与预算之间选择一项。');
  return settings;
}

export function effectiveReasoning(connection, model) {
  const override = connection.model_reasoning;
  return override && Object.hasOwn(override, model) ? override[model] : connection;
}

// The local connection owns these parameters, including explicitly omitting them.
// CLI defaults must not override a user's per-model or server-default selection.
export function applyReasoning(body, connection, protocol = connection.protocol) {
  const settings = effectiveReasoning(connection, body.model);
  const output = { ...body };
  const reasoning = { ...(body.reasoning || {}) };
  delete reasoning.effort; delete reasoning.enabled; delete reasoning.max_tokens;
  delete output.reasoning; delete output.reasoning_effort; delete output.thinking;
  if (Object.keys(reasoning).length) output.reasoning = reasoning;
  const effort = settings.reasoning_effort;
  const mode = settings.thinking_mode;
  const budget = settings.thinking_budget;
  const format = settings.thinking_format || 'effort';
  if (format === 'thinking') {
    const thinking = { ...(mode ? { type: mode } : {}), ...(budget !== undefined ? { budget_tokens: budget } : {}) };
    if (Object.keys(thinking).length) output.thinking = thinking;
  } else if (format === 'reasoning') {
    if (mode) reasoning.enabled = mode === 'enabled';
    if (budget !== undefined) reasoning.max_tokens = budget;
  }
  const value = format === 'effort' && mode === 'disabled' ? 'none' : effort;
  if (value) {
    if (protocol === 'responses' || format === 'reasoning') reasoning.effort = value;
    else output.reasoning_effort = value;
  }
  if (Object.keys(reasoning).length) output.reasoning = reasoning;
  return output;
}

export function reasoningCapabilities(model) {
  const levels = model.effort?.supported_levels || model.supported_reasoning_levels;
  const efforts = Array.isArray(levels) ? [...new Set(levels.map(level => typeof level === 'string' ? level : level?.effort).filter(rawValue))].slice(0, 32) : [];
  const defaultEffort = model.effort?.default_level || model.default_reasoning_level;
  return { ...(efforts.length ? { efforts } : {}), ...(rawValue(defaultEffort) ? { default_effort: defaultEffort } : {}) };
}
