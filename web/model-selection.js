export class ModelSelection {
  constructor(connection = {}) {
    this.models = [...(connection.models || [])];
    this.defaultModel = connection.default_model || this.models[0] || '';
    this.overrides = Object.assign(Object.create(null), structuredClone(connection.model_reasoning || {}));
  }
  add(text) {
    const additions = [...new Set(String(text).split(/[\r\n]+/).map(id => id.trim()).filter(Boolean))];
    if (!additions.length) throw new Error('请填写模型 ID。');
    if (additions.some(id => id.length > 200 || /[\s\0]/.test(id))) throw new Error('每行填写一个模型 ID，最多 200 个字符，不包含空格。');
    const next = [...new Set([...this.models, ...additions])];
    if (next.length > 100) throw new Error('最多添加 100 个模型。');
    this.models = next;
    if (!this.defaultModel) this.defaultModel = next[0];
  }
  remove(model) {
    this.models = this.models.filter(id => id !== model); delete this.overrides[model];
    if (this.defaultModel === model) this.defaultModel = this.models[0] || '';
  }
  setDefault(model) {
    if (!this.models.includes(model)) throw new Error('默认模型必须在已添加的模型中。');
    this.defaultModel = model;
  }
  snapshot() {
    return { models: [...this.models], default_model: this.defaultModel,
      model_reasoning: Object.fromEntries(Object.entries(this.overrides).filter(([id]) => this.models.includes(id))) };
  }
}
