// Keep the native selects as the form's source of truth; only replace their presentation.
export function createSelectMenus(doc = document) {
  const view = doc.defaultView;
  const menu = doc.createElement('div');
  menu.id = 'settings-select-menu'; menu.className = 'select-menu'; menu.hidden = true;
  menu.setAttribute('role', 'listbox'); doc.body.append(menu);
  let opened = null, active = -1, options = [], prefix = '', lastTyped = 0;
  const controls = [];
  const close = () => {
    if (opened) { opened.button.setAttribute('aria-expanded', 'false'); opened.button.removeAttribute('aria-activedescendant'); }
    menu.hidden = true; opened = null; prefix = '';
  };
  function highlight(index, scroll = false) {
    active = Number.isInteger(index) ? index : -1;
    for (const [i, item] of options.entries()) item.element.className = `select-option${i === active ? ' active' : ''}`;
    if (opened && options[active]) {
      opened.button.setAttribute('aria-activedescendant', options[active].element.id);
      if (scroll) options[active].element.scrollIntoView({ block: 'nearest' });
    }
  }
  function choose(index) {
    const item = options[index], control = opened;
    if (!control || !item || item.disabled || control.select.matches(':disabled')) return;
    const changed = control.select.value !== item.value;
    control.select.value = item.value; close(); refresh(); control.button.focus();
    if (changed) for (const type of ['input', 'change']) control.select.dispatchEvent(new Event(type, { bubbles: true }));
  }
  function render() {
    menu.replaceChildren();
    options = [...opened.select.querySelectorAll('option')].map((option, index) => {
      const element = doc.createElement('div'); element.id = `${menu.id}-${index}`;
      element.setAttribute('role', 'option'); element.setAttribute('aria-selected', String(option.value === opened.select.value));
      const disabled = option.disabled || Boolean(option.closest('optgroup')?.disabled);
      element.setAttribute('aria-disabled', String(disabled)); element.textContent = option.label || option.textContent;
      element.addEventListener('click', () => choose(index));
      element.addEventListener('pointermove', event => { if (event.pointerType === 'mouse' && !disabled) highlight(index); });
      menu.append(element); return { element, value: option.value, disabled };
    });
    let index = options.findIndex(item => item.value === opened.select.value && !item.disabled);
    if (index < 0) index = options.findIndex(item => !item.disabled);
    highlight(index);
  }
  function open(control) {
    if (control.select.matches(':disabled')) return;
    close(); opened = control; render();
    control.button.setAttribute('aria-expanded', 'true'); menu.setAttribute('aria-labelledby', control.label.id);
    const rect = control.button.getBoundingClientRect(), gap = 6, margin = 8;
    const below = Math.max(0, view.innerHeight - rect.bottom - gap - margin), above = Math.max(0, rect.top - gap - margin);
    const wanted = Math.min(292, options.length * 36 + 12), upward = below < wanted && above > below;
    const height = Math.min(wanted, upward ? above : below);
    const width = Math.min(rect.width, view.innerWidth - margin * 2);
    menu.style.width = `${width}px`; menu.style.maxHeight = `${height}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))}px`;
    menu.style.top = `${upward ? rect.top - gap - height : rect.bottom + gap}px`;
    menu.hidden = false; highlight(active, true);
  }
  function move(direction) {
    for (let offset = 1; offset <= options.length; offset++) {
      const index = (active + direction * offset + options.length) % options.length;
      if (!options[index].disabled) { highlight(index, true); break; }
    }
  }
  function keydown(event, control) {
    if (control.select.matches(':disabled')) return;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape') { if (opened === control) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (opened !== control) open(control);
      else if (event.key === 'Enter' || event.key === ' ' || (event.altKey && event.key === 'ArrowUp')) { choose(active); return; }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event.key === 'ArrowDown' ? 1 : -1);
      if (event.key === 'Home' || event.key === 'End') {
        const indices = options.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0);
        highlight(event.key === 'Home' ? indices[0] : indices.at(-1), true);
      }
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); if (opened !== control) open(control);
      const now = Date.now(); prefix = now - lastTyped < 700 ? prefix + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase(); lastTyped = now;
      const index = options.findIndex(item => !item.disabled && item.element.textContent.toLocaleLowerCase().startsWith(prefix));
      if (index >= 0) highlight(index, true);
    }
  }
  function refresh() {
    for (const control of controls) {
      const option = [...control.select.querySelectorAll('option')].find(option => option.value === control.select.value);
      control.value.textContent = option?.label || option?.textContent || '';
      control.button.disabled = control.select.matches(':disabled');
    }
    if (opened) { if (opened.button.disabled) close(); else render(); }
  }
  for (const select of doc.querySelectorAll('select')) {
    const label = doc.querySelector(`label[for="${select.id}"]`);
    if (!label) continue;
    const button = doc.createElement('button'), value = doc.createElement('span'), arrow = doc.createElement('span');
    button.type = 'button'; button.id = `${select.id}-trigger`; button.className = 'select-trigger';
    button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', menu.id);
    label.id ||= `${select.id}-label`; label.htmlFor = button.id;
    value.id = `${select.id}-value`; value.className = 'select-value';
    button.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
    arrow.className = 'select-arrow'; arrow.setAttribute('aria-hidden', 'true'); button.append(value, arrow);
    select.className += ' select-native'; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true'); select.after(button);
    const control = { select, button, value, label }; controls.push(control);
    button.addEventListener('click', () => { if (opened === control) close(); else open(control); });
    button.addEventListener('keydown', event => keydown(event, control));
    select.addEventListener('change', refresh);
  }
  doc.addEventListener('pointerdown', event => { if (opened && !opened.button.contains(event.target) && !menu.contains(event.target)) close(); });
  doc.addEventListener('scroll', event => { if (!menu.contains(event.target)) close(); }, true);
  doc.addEventListener('reset', () => { close(); queueMicrotask(refresh); });
  view.addEventListener('resize', close);
  refresh(); return { refresh, close };
}
