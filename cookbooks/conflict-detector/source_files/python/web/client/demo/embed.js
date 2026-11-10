import { h, icon } from '/demo/dom.js';
import { createTour } from '/demo/tour.js';

const UPLOAD = ['M12 3v12', 'm17 8-5-5-5 5', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'];
const MAXIMIZE = ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'];
const MINIMIZE = ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'];
const HELP = ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'];
const TRACKS = { rail: 'minmax(1.75rem, 2.25rem)', narrow: 'minmax(11rem, 14rem)', wide: 'minmax(20rem, 27rem)' };
const RESIZE_MIN = 176;

export function createEmbed({ chrome, headerExtraEl, actionsExtraEl, onUpload, expandAt, contentMaxWidth, headerPanels, tour: tourConfig, className = '' }) {
  const noticeEl = h('div', { className: 'demo-notice', role: 'status' });
  const helpBtn = h('button', { type: 'button', className: 'demo-icon-btn demo-focus', innerHTML: icon(HELP, 16) });
  const togglesEl = h('div', { className: 'demo-app__toggles' });
  const middleEl = h('div', { className: 'demo-app__header-extra demo-scroll demo-app__header-extra--centered' }, headerExtraEl);
  const actionsEl = h('div', { className: 'demo-app__actions' }, actionsExtraEl);
  const fullscreenBtn = h('button', { type: 'button', className: 'demo-icon-btn demo-focus', onclick: () => setFullscreen(!isFullscreen) });
  if (onUpload) {
    actionsEl.append(
      h(
        'button',
        { type: 'button', className: 'demo-btn demo-btn--outline demo-focus', innerHTML: icon(UPLOAD), onclick: onUpload },
        h('span', { className: 'demo-app__upload-label', textContent: 'Upload files' })
      )
    );
  }
  actionsEl.append(fullscreenBtn);
  const headerEl = h('header', { className: 'demo-app__header' }, helpBtn, togglesEl, middleEl, actionsEl);

  const contentEl = h('div', { className: 'demo-split__content' });
  if (contentMaxWidth) contentEl.style.setProperty('--demo-split-content-max-width', contentMaxWidth);
  const splitEl = h('main', { className: 'demo-split demo-app__main demo-scroll' });

  const frameEl = h('div', { className: 'demo-frame' }, h('div', { className: `demo-app ${className}` }, headerEl, splitEl), noticeEl);
  const el = h('div', { className: 'demo-embed' }, frameEl);

  const drawerTitleEl = h('h2', { id: 'demo-drawer-title', className: 'demo-drawer__title' });
  const drawerCloseBtn = h('button', {
    type: 'button',
    className: 'demo-icon-btn demo-icon-btn--plain demo-focus demo-focus--inset',
    textContent: '×',
    onclick: () => chrome.close()
  });
  const drawerBodyEl = h('div', { className: 'demo-drawer__body' });
  const dialogEl = h(
    'dialog',
    { 'aria-labelledby': 'demo-drawer-title', onclose: () => chrome.close() },
    h('div', { className: 'demo-drawer__panel' }, h('div', { className: 'demo-drawer__header' }, drawerTitleEl, drawerCloseBtn), drawerBodyEl)
  );

  const backdropEl = h('button', {
    type: 'button',
    className: 'demo-fullscreen-backdrop',
    'aria-label': 'Exit expanded view (click outside the demo)',
    'aria-hidden': 'true',
    tabIndex: -1,
    onclick: () => setFullscreen(false)
  });
  const portalHost = h('div', { className: 'demo-expanded-portal-host' }, backdropEl);
  document.body.append(portalHost);

  let panels = [];
  let isExpanded = false;
  let isFullscreen = false;
  let noticeTimer;
  const panes = new Map();
  const toggles = new Map();
  const sizes = new Map();

  const tour = createTour({
    ...tourConfig,
    frameEl,
    chrome,
    panelLabel: (id) => panels.find((panel) => panel.id === id)?.label ?? null,
    onChange: syncHelp
  });
  helpBtn.onclick = () => (tour.isOpen ? tour.close() : tour.start());

  function syncHelp(open) {
    const label = open ? 'Close tour' : 'Show tour';
    helpBtn.setAttribute('aria-label', label);
    helpBtn.title = label;
    helpBtn.setAttribute('aria-expanded', String(open));
  }
  syncHelp(false);

  function showNotice(text) {
    clearTimeout(noticeTimer);
    const textEl = h('p', { className: 'demo-notice__text', textContent: text });
    noticeEl.replaceChildren(textEl);
    requestAnimationFrame(() => textEl.classList.add('is-visible'));
    noticeTimer = setTimeout(() => {
      textEl.classList.remove('is-visible');
      noticeTimer = setTimeout(() => textEl.remove(), 200);
    }, 2600);
  }

  function syncFullscreenButton() {
    const label = isFullscreen ? 'Exit expanded view' : 'Expand demo';
    fullscreenBtn.innerHTML = icon(isFullscreen ? MINIMIZE : MAXIMIZE, 16);
    fullscreenBtn.setAttribute('aria-label', label);
    fullscreenBtn.setAttribute('aria-pressed', String(isFullscreen));
    fullscreenBtn.title = label;
  }
  syncFullscreenButton();

  function setFullscreen(next) {
    if (next === isFullscreen) return;
    chrome.close();
    isFullscreen = next;
    frameEl.classList.toggle('is-expanded', next);
    backdropEl.classList.toggle('is-visible', next);
    (next ? portalHost : el).append(frameEl);
    syncFullscreenButton();
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (tour.isOpen) tour.close();
    else if (isFullscreen && !document.querySelector('.demo-dialog[open]')) setFullscreen(false);
  });

  const expanded = (panel) => isExpanded && panel.expandedWidth !== undefined;
  const isRail = (panel) => panel.width === 'rail' && !expanded(panel);
  const columns = (list) =>
    [
      ...list.filter((panel) => panel.side === 'left'),
      null,
      ...list.filter((panel) => panel.side === 'right')
    ]
      .map((panel) =>
        !panel
          ? 'minmax(0, 1fr)'
          : sizes.has(panel.id) && !isRail(panel)
            ? `${sizes.get(panel.id)}px`
            : TRACKS[expanded(panel) ? panel.expandedWidth : panel.width ?? 'narrow']
      )
      .join(' ');

  function setSize(panel, width) {
    const max = Math.max(splitEl.getBoundingClientRect().width * 0.45, RESIZE_MIN);
    sizes.set(panel.id, Math.round(Math.min(Math.max(width, RESIZE_MIN), max)));
    render();
  }

  function createPane() {
    const pane = { asideEl: h('aside'), titleEl: h('h3', { className: 'demo-panel__title' }), slotEl: h('div', { className: 'demo-panel__body' }) };
    const handleEl = (pane.handleEl = h('div', {
      className: 'demo-split__resize demo-focus',
      role: 'separator',
      'aria-orientation': 'vertical',
      tabIndex: 0,
      title: 'Drag to resize, double-click to reset',
      onkeydown: (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const grows = (event.key === 'ArrowLeft') === (pane.panel.side === 'right');
        setSize(pane.panel, pane.asideEl.getBoundingClientRect().width + (grows ? 16 : -16));
      },
      ondblclick: () => {
        sizes.delete(pane.panel.id);
        render();
      },
      onpointerdown: (event) => {
        const { panel } = pane;
        const rect = pane.asideEl.getBoundingClientRect();
        handleEl.setPointerCapture(event.pointerId);
        handleEl.onpointermove = (e) => setSize(panel, panel.side === 'right' ? rect.right - e.clientX : e.clientX - rect.left);
        handleEl.onpointerup = handleEl.onpointercancel = () => (handleEl.onpointermove = null);
      }
    }));
    return pane;
  }

  function renderAside(panel) {
    if (!panes.has(panel.id)) panes.set(panel.id, createPane());
    const pane = panes.get(panel.id);
    const { asideEl, titleEl, slotEl, handleEl } = pane;
    const rail = isRail(panel);
    const useColumnBody = panel.columnBodyEl && !expanded(panel);
    pane.panel = panel;
    asideEl.className = `demo-panel demo-panel--${panel.side}${rail ? ' demo-panel--rail' : ''}`;
    asideEl.setAttribute('aria-label', panel.label ?? '');

    if (!useColumnBody && panel.showLabelWhenWide !== false) {
      titleEl.textContent = panel.label ?? '';
      if (asideEl.firstChild !== titleEl) asideEl.prepend(titleEl);
    } else titleEl.remove();
    if (slotEl.parentNode !== asideEl) asideEl.append(slotEl);

    if (rail) handleEl.remove();
    else {
      handleEl.setAttribute('aria-label', `Resize ${(panel.label ?? 'panel').toLowerCase()}`);
      if (sizes.has(panel.id)) handleEl.setAttribute('aria-valuenow', String(sizes.get(panel.id)));
      else handleEl.removeAttribute('aria-valuenow');
      if (handleEl.parentNode !== asideEl) asideEl.append(handleEl);
    }

    const body = useColumnBody ? panel.columnBodyEl : panel.bodyEl;
    if (slotEl.firstChild !== body) slotEl.replaceChildren(body);
    return asideEl;
  }

  const same = (parent, nodes) => parent.childNodes.length === nodes.length && nodes.every((node, i) => parent.childNodes[i] === node);

  function render() {
    const wide = chrome.isWide;
    const side = (name) => (wide ? panels.filter((panel) => panel.side === name).map(renderAside) : []);
    splitEl.classList.toggle('is-wide', wide);
    splitEl.style.gridTemplateColumns = wide ? columns(panels) : '';
    chrome.set({ columns: wide ? columns(panels.length ? panels : headerPanels ?? panels) : undefined });

    const desired = [...side('left'), contentEl, ...side('right'), dialogEl];
    if (!same(splitEl, desired)) splitEl.replaceChildren(...desired);

    const open = !wide && panels.find((panel) => panel.id === chrome.drawer);
    if (!open) {
      if (dialogEl.open) dialogEl.close();
    } else {
      dialogEl.className = `demo-drawer demo-drawer--${open.side ?? 'left'}`;
      drawerTitleEl.textContent = open.label ?? '';
      drawerCloseBtn.setAttribute('aria-label', `Close ${(open.label ?? '').toLowerCase()}`);
      if (drawerBodyEl.firstChild !== open.bodyEl) drawerBodyEl.replaceChildren(open.bodyEl);
      if (!dialogEl.open) dialogEl.showModal();
    }
  }

  function renderHeader() {
    const show = panels.length > 0 && !chrome.isWide;
    togglesEl.style.display = show ? '' : 'none';
    const desired = show
      ? panels.map((panel) => {
          if (!toggles.has(panel.id)) {
            const button = h('button', {
              type: 'button',
              'aria-haspopup': 'dialog',
              onclick: () => chrome.openDrawer(chrome.drawer === panel.id ? null : panel.id)
            });
            button.dataset.demoPanelToggle = panel.id;
            toggles.set(panel.id, button);
          }
          const button = toggles.get(panel.id);
          button.className = `demo-btn demo-btn--outline demo-focus demo-panel-toggle${panel.iconSvg ? ' demo-panel-toggle--icon' : ''}`;
          button.setAttribute('aria-expanded', String(chrome.drawer === panel.id));
          if (panel.iconSvg) {
            button.setAttribute('aria-label', panel.label ?? '');
            button.title = panel.label ?? '';
            button.innerHTML = panel.iconSvg;
          } else {
            button.removeAttribute('aria-label');
            button.removeAttribute('title');
            button.textContent = panel.label ?? '';
          }
          return button;
        })
      : [];
    if (!same(togglesEl, desired)) togglesEl.replaceChildren(...desired);

    const template = chrome.columns;
    headerEl.classList.toggle('demo-app__header--grid', Boolean(template));
    headerEl.style.gridTemplateColumns = template ?? '';
    helpBtn.style.gridColumn = template ? '1' : '';
    middleEl.style.gridColumn = template ? '2' : '';
    actionsEl.style.gridColumn = template ? '3' : '';
  }

  function measure() {
    const width = splitEl.getBoundingClientRect().width;
    isExpanded = width >= expandAt;
    if (width >= 832 !== chrome.isWide) {
      chrome.set({ isWide: width >= 832 });
      if (chrome.isWide) chrome.close();
    }
    render();
  }

  new ResizeObserver(measure).observe(splitEl);
  chrome.subscribe(() => {
    render();
    renderHeader();
  });
  measure();
  renderHeader();

  function update({ panels: next, fillHeight }) {
    panels = next;
    splitEl.classList.toggle('demo-split--fill', Boolean(fillHeight));
    measure();
    renderHeader();
  }

  return { el, contentEl, tour, update, showNotice };
}
