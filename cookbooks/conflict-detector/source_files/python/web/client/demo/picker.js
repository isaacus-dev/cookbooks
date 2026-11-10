import { h, icon } from '/demo/dom.js';

const EDGE = 12;
const GAP = 6;
const CHEVRON_DOWN = ['m6 9 6 6 6-6'];
const CHEVRON_RIGHT = ['m9 18 6-6-6-6'];
const FOLDER = ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'];
const FOLDER_OPEN = [
  'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
];
const SEARCH = ['M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'm21 21-4.3-4.3'];

let counter = 0;

export function createPicker({ label = '', onChange, plain = false, prefix, searchable = true, className } = {}) {
  const id = `demo-picker-${(counter += 1)}`;
  const listId = `${id}-list`;

  let value;
  let options = [];
  let isOpen = false;
  let activeValue = null;
  let moved = false;
  let frame = 0;
  const collapsed = new Set();

  const labelEl = h('span', { className: 'demo-picker__label demo-sr-only', id: `${id}-label`, textContent: label });
  const valueEl = h('span', { className: 'demo-picker__value' });
  const triggerEl = h(
    'button',
    {
      type: 'button',
      className: 'demo-picker__trigger demo-focus',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': listId,
      onclick: () => (isOpen ? hide() : show())
    },
    ...(prefix ? [h('span', { className: 'demo-picker__prefix', textContent: prefix })] : []),
    valueEl
  );
  triggerEl.insertAdjacentHTML('beforeend', icon(CHEVRON_DOWN, 16));

  const searchEl = h('input', {
    type: 'text',
    placeholder: 'Search documents',
    autocomplete: 'off',
    spellcheck: false,
    role: 'combobox',
    'aria-label': `Search ${label.toLowerCase()}s`,
    'aria-controls': listId,
    'aria-expanded': 'true',
    oninput: () => {
      const visible = visibleOptions();
      if (!visible.some((option) => option.value === activeValue)) activeValue = visible[0]?.value ?? null;
      renderList();
    }
  });
  const listEl = h('div', { className: 'demo-picker__list demo-scroll', id: listId, role: 'listbox', 'aria-labelledby': labelEl.id });
  if (!searchable) listEl.tabIndex = -1;

  const popoverEl = h('div', { className: 'demo-picker__popover', popover: 'manual' });
  if (searchable) popoverEl.append(h('div', { className: 'demo-picker__search', innerHTML: icon(SEARCH, 16) }, searchEl));
  popoverEl.append(listEl);

  const el = h('div', { className: ['demo-picker', plain && 'demo-picker--plain', className].filter(Boolean).join(' ') }, labelEl, triggerEl, popoverEl);

  const optionId = (optionValue) => `${id}-option-${options.findIndex((option) => option.value === optionValue)}`;
  const query = () => searchEl.value.trim();
  const groupOpen = (group) => !group || Boolean(query()) || !collapsed.has(group);
  const matches = () => options.filter((option) => option.label.toLowerCase().includes(query().toLowerCase()));
  const visibleOptions = () => matches().filter((option) => groupOpen(option.group));
  const scrollToActive = () => document.getElementById(optionId(activeValue))?.scrollIntoView({ block: 'nearest' });

  function renderTrigger() {
    const selected = options.find((option) => option.value === value);
    valueEl.textContent = selected?.label ?? label;
    triggerEl.setAttribute('aria-label', `${label}: ${selected?.label ?? ''}`);
  }

  function syncActiveDescendant() {
    const owner = searchable ? searchEl : listEl;
    if (activeValue) owner.setAttribute('aria-activedescendant', optionId(activeValue));
    else owner.removeAttribute('aria-activedescendant');
  }

  function renderList() {
    const found = matches();
    const groups = [...new Set(found.map((option) => option.group))];
    const headers = groups.filter(Boolean).length > 1;
    listEl.replaceChildren();

    for (const group of groups) {
      const open = groupOpen(group);
      const items = found.filter((option) => option.group === group);
      if (group && headers) {
        listEl.append(
          h(
            'button',
            {
              type: 'button',
              className: 'demo-picker__group',
              tabIndex: -1,
              'aria-expanded': String(open),
              innerHTML: open ? icon(CHEVRON_DOWN, 14) + icon(FOLDER_OPEN, 16) : icon(CHEVRON_RIGHT, 14) + icon(FOLDER, 16),
              onclick: () => {
                if (!collapsed.delete(group)) collapsed.add(group);
                renderList();
                searchEl.focus();
              }
            },
            h('span', { className: 'demo-picker__group-label', textContent: group }),
            h('span', { className: 'demo-picker__count', textContent: String(items.length) })
          )
        );
      }
      if (!open) continue;

      for (const option of items) {
        const nested = group && headers ? ' demo-picker__option--nested' : '';
        const active = (moved || query()) && option.value === activeValue ? ' is-active' : '';
        listEl.append(
          h(
            'div',
            {
              id: optionId(option.value),
              className: `demo-picker__option${nested}${active}`,
              role: 'option',
              'aria-selected': String(option.value === value),
              tabIndex: -1,
              onpointerenter: () => setActive(option.value),
              onclick: () => choose(option.value)
            },
            h('span', { className: 'demo-picker__option-label', textContent: option.label })
          )
        );
      }
    }

    if (!found.length) listEl.append(h('p', { className: 'demo-picker__empty', textContent: 'No documents match.' }));
    syncActiveDescendant();
  }

  function setActive(next) {
    activeValue = next;
    moved = true;
    for (const optionEl of listEl.querySelectorAll('.demo-picker__option')) {
      optionEl.classList.toggle('is-active', optionEl.id === optionId(next));
    }
    syncActiveDescendant();
  }

  function place() {
    const rect = triggerEl.getBoundingClientRect();
    const bounds = triggerEl.closest('.demo-frame')?.getBoundingClientRect();
    const minX = Math.max(bounds?.left ?? 0, 0) + EDGE;
    const maxX = Math.min(bounds?.right ?? window.innerWidth, window.innerWidth) - EDGE;
    const width = Math.min(Math.max(rect.width, searchable ? 352 : 200), maxX - minX);
    popoverEl.style.width = `${width}px`;
    popoverEl.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - width / 2, minX), maxX - width)}px`;
    popoverEl.style.top = `${rect.bottom + GAP}px`;
    popoverEl.style.maxHeight = `${Math.max(window.innerHeight - rect.bottom - GAP - EDGE, 160)}px`;
  }

  function onPointerDown(event) {
    if (!popoverEl.contains(event.target) && !triggerEl.contains(event.target)) hide(false);
  }

  function show() {
    isOpen = true;
    searchEl.value = '';
    activeValue = value ?? null;
    moved = false;
    renderList();
    triggerEl.setAttribute('aria-expanded', 'true');
    popoverEl.showPopover();
    frame = requestAnimationFrame(function loop() {
      place();
      frame = requestAnimationFrame(loop);
    });
    place();
    document.addEventListener('pointerdown', onPointerDown, true);
    (searchable ? searchEl : listEl).focus();
    if (activeValue) scrollToActive();
  }

  function hide(refocus = true) {
    if (!isOpen) return;
    isOpen = false;
    cancelAnimationFrame(frame);
    document.removeEventListener('pointerdown', onPointerDown, true);
    triggerEl.setAttribute('aria-expanded', 'false');
    if (popoverEl.matches(':popover-open')) popoverEl.hidePopover();
    if (refocus) triggerEl.focus();
  }

  function choose(next) {
    hide();
    if (next !== value) onChange?.(next);
  }

  popoverEl.onkeydown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const visible = visibleOptions();
      if (!visible.length) return;
      const current = visible.findIndex((option) => option.value === activeValue);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(visible[current === -1 ? 0 : (current + step + visible.length) % visible.length].value);
      scrollToActive();
    } else if (event.key === 'Enter' && activeValue) {
      event.preventDefault();
      choose(activeValue);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  };
  popoverEl.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next && !popoverEl.contains(next) && !triggerEl.contains(next)) hide(false);
  });

  renderTrigger();

  function update(next = {}) {
    if (next.value !== undefined) value = next.value;
    if (next.options !== undefined) options = next.options;
    renderTrigger();
    if (isOpen) renderList();
  }

  return { el, update };
}
