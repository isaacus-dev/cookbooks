import { actionLabel } from '/review/lib/redline.js';
import { button, icon } from '/review/icons.js';

export function renderChanges(review, onShow) {
  const made = review.made;
  if (!made.length) {
    const empty = document.createElement('p');
    empty.className = 'rd-empty';
    empty.textContent = 'Nothing decided yet. Your decisions show here, and you can undo any of them.';
    return empty;
  }

  const list = document.createElement('ol');
  list.className = 'rch';
  for (const change of made) {
    const action = review.decided(change.key);
    const item = document.createElement('li');
    item.className = 'rch-item';
    const title = button({ className: 'rch-title demo-focus', html: '', onClick: () => onShow(change) });
    title.textContent = change.title;
    const state = document.createElement('span');
    state.className = 'rch-state';
    state.textContent =
      actionLabel(change.kind, action) + (action === 'rewrite' && review.edited(change.key) ? ', edited' : '');
    item.append(
      title,
      state,
      button({
        className: 'rch-undo demo-icon-btn demo-icon-btn--plain demo-focus',
        label: `Undo ${change.title}`,
        title: 'Undo',
        html: icon('undo2', { size: 15 }),
        onClick: () => review.undo(change.key),
      }),
    );
    list.append(item);
  }
  return list;
}
