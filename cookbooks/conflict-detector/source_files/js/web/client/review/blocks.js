import { buildMarkdownBlocks } from '/demo/markdown.js';

export function appendRun(parent, seg) {
  if (!seg.strong && !seg.emphasis) return parent.append(seg.text);
  const el = document.createElement(seg.strong ? 'strong' : 'em');
  el.textContent = seg.text;
  parent.append(el);
}

export function renderBlocks(blocks, anchors, className = '') {
  const el = document.createElement('div');
  el.className = `cdx-blocks ${className}`;
  for (const block of blocks) {
    const p = document.createElement('p');
    if (anchors) p.dataset.demoBlock = String(block.start);
    if (block.kind === 'heading') {
      p.className = anchors ? 'cdx-blocks__heading demo-doc__heading' : 'cdx-blocks__heading';
      p.textContent = block.text;
    } else {
      p.className = 'cdx-blocks__para';
      if (block.indent) p.style.paddingLeft = `${block.indent * 0.75}em`;
      if (block.marker) {
        const marker = document.createElement('span');
        marker.className = `cdx-blocks__marker${block.marker.length > 1 ? ' cdx-blocks__marker--number' : ''}`;
        marker.textContent = block.marker;
        p.append(marker);
      }
      for (const seg of block.segments) appendRun(p, seg);
    }
    el.append(p);
  }
  return el;
}

export const renderMarkdown = (markdown, className) => renderBlocks(buildMarkdownBlocks(markdown, []), false, className);
