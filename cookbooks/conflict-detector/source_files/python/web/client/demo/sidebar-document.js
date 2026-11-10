import { createDocumentViewer } from '/demo/document-viewer.js';
import { h, icon } from '/demo/dom.js';

export function createSidebarDocument({ backLabel = 'Back', onBack, ...viewerOptions } = {}) {
  const titleEl = h('h3', { className: 'demo-sidebar-doc__title' });
  const backBtn = h('button', {
    type: 'button',
    className: 'demo-sidebar-doc__back demo-focus',
    innerHTML: icon(['m12 19-7-7 7-7', 'M19 12H5'], 14),
    onclick: () => onBack?.(),
  }, backLabel);
  const viewer = createDocumentViewer(viewerOptions);
  const el = h('div', { className: 'demo-sidebar-doc' }, h('div', { className: 'demo-sidebar-doc__header' }, backBtn, titleEl), viewer.el);

  function update({ title, blocks, activeKey = null } = {}) {
    titleEl.textContent = title ?? '';
    viewer.update({ blocks, activeKey });
  }

  return { el, bodyEl: viewer.bodyEl, setHoverKey: viewer.setHoverKey, update };
}
