import { buildMarkdownBlocks } from '/demo/markdown.js';
import { REVIEW_ACCENTS, redlineDiff } from '/review/lib/redline.js';
import { appendRun, renderBlocks, renderMarkdown } from '/review/blocks.js';

export function createRedlineDoc(review, onSelect) {
  const el = document.createElement('div');
  el.className = 'rdoc';
  const boxes = new Map();
  let currentKey = null;

  function paint(key) {
    const [box, change] = boxes.get(key) ?? [];
    if (!box) return;
    const decided = review.decided(key);
    const action = review.action(key);
    const text = review.text(change);
    const draft = change.draft ?? '';
    box.toggleAttribute('data-decided', Boolean(decided));
    box.classList.toggle('is-current', key === currentKey);
    box.style.setProperty('--rdoc-accent', decided ? 'var(--cdx-done)' : REVIEW_ACCENTS[change.kind]);
    if (change.kind === 'missing') {
      return box.replaceChildren(
        action === 'rewrite' ? renderMarkdown(text, 'rb-insert') : renderMarkdown(change.standard ?? '', 'rb-absent'),
      );
    }
    if (action !== 'rewrite') return box.replaceChildren(renderMarkdown(draft, action === 'remove' ? 'rb-struck' : ''));
    const diff = change.draft && redlineDiff(change.draft, text);
    if (!diff) return box.replaceChildren(renderMarkdown(draft, 'rb-struck'), renderMarkdown(text, 'rb-insert'));
    const p = document.createElement('p');
    p.className = 'rb-diff';
    for (const part of diff) {
      if (part.type === 'same') {
        appendRun(p, part);
        continue;
      }
      const mark = document.createElement(part.type === 'removed' ? 'del' : 'ins');
      appendRun(mark, { ...part, text: part.text.replace(/\n+/g, '¶$&') });
      p.append(mark);
    }
    box.replaceChildren(p);
  }

  function render() {
    boxes.clear();
    el.replaceChildren();
    if (!review.run) return;
    const changes = review.unfiltered;
    const missing = changes.filter((change) => change.kind === 'missing');
    const place = (change) => {
      if (boxes.has(change.key)) return;
      const box = document.createElement('div');
      box.className = 'rdoc-change';
      box.addEventListener('click', () => onSelect(change));
      boxes.set(change.key, [box, change]);
      el.append(box);
      paint(change.key);
    };
    let next = 0;
    const marks = changes
      .filter((change) => change.draftSpan)
      .map((change) => ({ ...change.draftSpan, kind: change.kind, keys: [change.key] }));
    for (const block of buildMarkdownBlocks(review.run.input, marks)) {
      while (missing[next]?.at <= block.start) place(missing[next++]);
      const keys = block.kind === 'paragraph' ? block.segments.flatMap((seg) => seg.keys ?? []) : [];
      for (const key of keys) place(changes.find((change) => change.key === key));
      if (keys.length) continue;
      const wrap = document.createElement('div');
      wrap.className = 'rdoc-block';
      if (block.kind === 'heading') wrap.dataset.level = String(block.level);
      wrap.append(renderBlocks([block], true));
      el.append(wrap);
    }
    missing.slice(next).forEach(place);
  }

  function setCurrent(key) {
    boxes.get(currentKey)?.[0].classList.remove('is-current');
    currentKey = key;
    boxes.get(key)?.[0].classList.add('is-current');
  }

  return { el, render, paint, setCurrent, passage: (key) => boxes.get(key)?.[0] };
}
