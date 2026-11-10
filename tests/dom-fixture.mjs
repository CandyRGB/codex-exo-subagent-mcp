// Small DOM fixture for controller tests; layout and browser painting are not emulated.
class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag; this.attributes = { ...attributes }; this.children = []; this.listeners = new Map(); this.parent = null;
    this.value = attributes.value || ''; this.checked = 'checked' in attributes; this.disabled = 'disabled' in attributes;
    this.required = 'required' in attributes; this.hidden = 'hidden' in attributes; this.open = false; this.className = attributes.class || ''; this._text = '';
    this.style = {};
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === 'fragment') { this.append(...[...child.children]); continue; }
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this; this.children.push(child); if (this.tagName === 'select' && child.tagName === 'option' && !this.value) this.value = child.value;
    }
  }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
  async dispatch(name, properties = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...properties }; for (const handler of this.listeners.get(name) || []) await handler(event); }
  dispatchEvent(event) { for (const handler of this.listeners.get(event.type) || []) handler({ target: this, preventDefault() {}, stopPropagation() {} }); return true; }
  after(element) { element.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, element); }
  matches(selector) {
    if (selector === ':disabled') { for (let node = this; node; node = node.parent) if (node.disabled) return true; return false; }
    const match = selector.match(/^(\w+|\*)?(?:\[([\w-]+)="([^"]*)"\])?$/);
    return Boolean(match && (!match[1] || match[1] === '*' || match[1] === this.tagName) && (!match[2] || this.getAttribute(match[2]) === match[3]));
  }
  closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  getBoundingClientRect() { return this.rect || { left: 100, top: 100, bottom: 139, width: 300, height: 39 }; }
  querySelectorAll(selector) {
    const tags = selector.split(',').map(tag => tag.trim()); const all = [];
    const walk = root => { for (const child of root.children) { if (tags.some(tag => child.matches(tag))) all.push(child); walk(child); } }; walk(this); return all;
  }
  querySelector(selector) {
    const match = selector.match(/^(\w+)\[value="([^"]+)"\]$/);
    return match ? this.querySelectorAll(match[1]).find(child => child.value === match[2]) : this.querySelectorAll(selector)[0];
  }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  focus() { let root = this; while (root.parent) root = root.parent; root.activeElement = this; }
  scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
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
  const document = new Element('document'), stack = [document];
  let cursor = 0;
  for (const match of html.matchAll(/<(\/?)([\w-]+)([^>]*?)>/g)) {
    stack.at(-1)._text += html.slice(cursor, match.index).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); cursor = match.index + match[0].length;
    const [, close, tag, raw] = match;
    if (close) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const attributes = Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(item => [item[1], item[2] ?? '']));
    const element = new Element(tag, attributes); stack.at(-1).append(element);
    if (!raw.endsWith('/') && !['input', 'meta', 'link', 'br', 'hr'].includes(tag)) stack.push(element);
  }
  document.getElementById = id => document.querySelectorAll('*').find(node => node.id === id);
  document.createElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element('fragment');
  document.body = document.querySelectorAll('body')[0];
  document.defaultView = new Element('window'); document.defaultView.innerWidth = 1024; document.defaultView.innerHeight = 768;
  return document;
}

export async function eventually(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Controller did not reach expected state'); await new Promise(done => setTimeout(done, 5)); }
}
