// Small DOM fixture for controller tests; layout and browser painting are not emulated.
class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag; this.attributes = { ...attributes }; this.children = []; this.listeners = new Map(); this.parent = null;
    this.value = attributes.value || ''; this.checked = 'checked' in attributes; this.disabled = 'disabled' in attributes;
    this.required = 'required' in attributes; this.hidden = 'hidden' in attributes; this.open = false; this.className = attributes.class || ''; this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); if (this.tagName === 'select' && child.tagName === 'option' && !this.value) this.value = child.value; }
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
  async dispatch(name) { for (const handler of this.listeners.get(name) || []) await handler({ target: this, preventDefault() {} }); }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim()); const all = [];
    const walk = root => { for (const child of root.children) { if (tags.includes(child.tagName)) all.push(child); walk(child); } }; walk(this); return all;
  }
  querySelector(selector) {
    const match = selector.match(/^(\w+)\[value="([^"]+)"\]$/);
    return match ? this.querySelectorAll(match[1]).find(child => child.value === match[2]) : this.querySelectorAll(selector)[0];
  }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  focus() {} scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  reset() {
    for (const item of this.querySelectorAll('input, select, textarea')) { item.value = item.attributes.value || ''; item.checked = 'checked' in item.attributes; }
  }
  reportValidity() {
    return this.querySelectorAll('input, select, textarea').every(item => {
      for (let ancestor = item; ancestor; ancestor = ancestor.parent) if (ancestor.disabled) return true;
      return !item.required || Boolean(item.value);
    });
  }
}

export function documentFixture(html) {
  const document = new Element('document'), ids = new Map(), stack = [document];
  for (const match of html.matchAll(/<(\/?)([\w-]+)([^>]*?)>/g)) {
    const [, close, tag, raw] = match;
    if (close) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const attributes = Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(item => [item[1], item[2] ?? '']));
    const element = new Element(tag, attributes); stack.at(-1).append(element);
    if (attributes.id) ids.set(attributes.id, element);
    if (!raw.endsWith('/') && !['input', 'meta', 'link', 'br', 'hr'].includes(tag)) stack.push(element);
  }
  document.getElementById = id => ids.get(id);
  document.createElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element('fragment');
  document.body = document.querySelectorAll('body')[0];
  return document;
}

export async function eventually(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Controller did not reach expected state'); await new Promise(done => setTimeout(done, 5)); }
}
