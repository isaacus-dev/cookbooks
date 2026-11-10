import { h } from '/demo/dom.js';

export function createFindingsPanel({ headerEl, onSelectFilter, onSelectRow, onHoverRow, onAction, registerRow }) {
  const tabsEl = h('div', { className: 'demo-tabs', role: 'tablist' });
  const listEl = h('div', { className: 'demo-findings__list demo-scroll' });
  const el = h('div', { className: 'demo-findings' }, h('div', { className: 'demo-findings__top' }, headerEl, tabsEl), listEl);

  let hoverKey = null;
  let shownFilter;

  function setHoverKey(key) {
    hoverKey = key;
    for (const node of listEl.querySelectorAll('.demo-row, .demo-row__match')) {
      node.classList.toggle('is-hover', node.dataset.keys.split(' ').includes(key));
    }
  }

  function hover(key) {
    if (hoverKey === key) return;
    setHoverKey(key);
    onHoverRow(key);
  }

  const selected = () => window.getSelection()?.isCollapsed === false;

  const excerptEl = ({ text, quote }) =>
    h(
      'span',
      { className: quote ? 'demo-row__excerpt demo-row__excerpt--muted demo-row__excerpt--indent' : 'demo-row__excerpt' },
      h('span', { className: 'demo-row__text', textContent: text })
    );

  function buildRow(row, activeKey) {
    const { key, keys = [key], title, accent, excerpts = [], matches = [], action } = row;
    const has = (k) => keys.includes(k);
    const article = h('article', {
      className: `demo-row${has(activeKey) ? ' is-active' : ''}${has(hoverKey) ? ' is-hover' : ''}`,
      onpointermove: () => hover(key),
      onpointerleave: () => {
        setHoverKey(null);
        onHoverRow(null);
      },
      onclick: () => selected() || onSelectRow(key)
    });
    article.dataset.key = key;
    article.dataset.keys = keys.join(' ');
    if (accent) article.style.setProperty('--demo-row-accent', accent);

    const titleEl = h('button', {
      type: 'button',
      className: 'demo-row__title demo-focus',
      textContent: title,
      onclick: (event) => {
        event.stopPropagation();
        onSelectRow(key);
      }
    });
    const hit = h('div', { className: 'demo-row__hit' }, h('div', { className: 'demo-row__head' }, titleEl), ...excerpts.map(excerptEl));

    for (const match of matches) {
      const matchEl = h(
        'div',
        {
          className: `demo-row__match demo-focus${activeKey === match.key ? ' is-active' : ''}${hoverKey === match.key ? ' is-hover' : ''}`,
          role: 'button',
          tabIndex: 0,
          onclick: (event) => {
            event.stopPropagation();
            selected() || onSelectRow(match.key);
          },
          onkeydown: (event) => {
            if (event.target !== matchEl || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            onSelectRow(match.key);
          },
          onpointermove: (event) => {
            event.stopPropagation();
            hover(match.key);
          }
        },
        ...match.excerpts.map(excerptEl)
      );
      matchEl.dataset.keys = match.key;
      hit.append(matchEl);
    }
    article.append(hit);

    if (action) {
      article.append(
        h('button', {
          type: 'button',
          className: 'demo-row__action demo-focus',
          textContent: `${action} →`,
          onclick: (event) => {
            event.stopPropagation();
            onAction(row);
          }
        })
      );
    }

    registerRow(article, keys);
    return article;
  }

  function update({ filters = [], activeFilter, rows = [], activeKey = null }) {
    const hasFilters = filters.length > 1 && activeFilter !== undefined;
    tabsEl.style.display = hasFilters ? '' : 'none';
    if (hasFilters) {
      tabsEl.replaceChildren(
        ...filters.map((tab) => {
          const active = tab.id === activeFilter;
          const button = h(
            'button',
            {
              type: 'button',
              className: "demo-tabs__tab demo-focus",
              role: 'tab',
              'aria-selected': String(active),
              tabIndex: active ? 0 : -1,
              onclick: () => onSelectFilter(tab.id)
            },
            h('span', { className: 'demo-tabs__label', textContent: tab.label }),
            h('span', { className: 'demo-tabs__count', textContent: String(tab.count) })
          );
          button.dataset.tab = tab.id;
          if (tab.accent) button.style.setProperty('--demo-tab-accent', tab.accent);
          return button;
        })
      );
    }

    listEl.classList.toggle('is-refiltered', shownFilter !== undefined && activeFilter !== undefined && activeFilter !== shownFilter);
    if (activeFilter !== undefined) shownFilter = activeFilter;

    const groups = [];
    for (const row of rows) {
      const last = groups.at(-1);
      if (last && row.group !== undefined && row.group === last.label) last.rows.push(row);
      else groups.push({ label: row.group, rows: [row] });
    }

    const scrollTop = listEl.scrollTop;
    listEl.replaceChildren(
      ...groups.map((group, index) => {
        const section = h('section', { className: 'demo-findings__group' });
        section.style.setProperty('--demo-enter-index', String(Math.min(index, 5)));
        if (group.label !== undefined) {
          section.append(
            h(
              'h4',
              { className: 'demo-findings__group-label' },
              h('span', { textContent: group.label }),
              h('span', { className: 'demo-findings__group-count', textContent: String(group.rows.length), hidden: group.rows.length < 2 })
            )
          );
        }
        section.append(...group.rows.map((row) => buildRow(row, activeKey)));
        return section;
      })
    );
    if (!rows.length) listEl.append(h('p', { className: 'demo-findings__empty', textContent: 'None found.' }));
    listEl.scrollTop = scrollTop;
  }

  return { el, listEl, update, setHoverKey };
}
