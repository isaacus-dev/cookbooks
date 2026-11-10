import { ACTIONS_FOR, REVIEW_ACCENTS, actionHint, actionLabel } from '/review/lib/redline.js';
import { renderMarkdown } from '/review/blocks.js';
import { button, icon } from '/review/icons.js';
import { createRewriteEditorEl } from '/review/rewrite-editor.js';

const iconFor = (kind, option) =>
  option === 'rewrite' ? (kind === 'missing' ? 'plus' : 'penLine') : option === 'remove' ? 'x' : 'check';

function cardShell(review, change) {
  const el = document.createElement('article');
  el.className = 'rc';
  el.dataset.card = change.key;
  el.style.setProperty('--rc-accent', REVIEW_ACCENTS[change.kind]);
  el.toggleAttribute('data-decided', Boolean(review.decided(change.key)));
  const text = review.comment(change);
  if (text) {
    const p = document.createElement('p');
    p.className = 'rc-comment';
    p.textContent = text;
    el.append(p);
  }
  return el;
}

export function renderListCard(review, change, current, onSelect) {
  const el = cardShell(review, change);
  el.classList.toggle('is-current', current);
  el.addEventListener('click', () => {
    if (window.getSelection()?.isCollapsed !== false) onSelect(change);
  });

  const head = document.createElement('div');
  head.className = 'rc-head';
  const title = button({
    className: 'rc-title demo-focus',
    html: '',
    onClick: (event) => {
      event.stopPropagation();
      onSelect(change);
    },
  });
  title.textContent = change.title;
  head.append(title);

  const decided = review.decided(change.key);
  if (decided) {
    const state = document.createElement('span');
    state.className = 'rc-state';
    state.title = actionLabel(change.kind, decided);
    state.setAttribute('aria-label', state.title);
    state.innerHTML = icon(iconFor(change.kind, decided), { size: 14, strokeWidth: 2.2 });
    head.append(state);
  }

  el.prepend(head);
  return el;
}

export function createOpenCard(review, change, onViewReference) {
  const el = cardShell(review, change);
  el.classList.add('is-open', 'is-current');

  for (const quote of review.quotes(change)) {
    const figure = document.createElement('figure');
    figure.className = 'rc-quote';
    if (quote.section || quote.span) {
      const caption = document.createElement('figcaption');
      caption.className = 'rc-quote__label';
      const label = document.createElement('span');
      label.textContent = `Reference: ${quote.section ?? 'the reference document'}`;
      caption.append(label);
      if (quote.span) {
        caption.append(
          button({
            className: 'rc-view demo-focus',
            label: `View ${quote.section ?? 'this clause'} in the reference document`,
            title: 'View in the reference document',
            html: icon('eye', { size: 14 }),
            onClick: () => onViewReference(quote.span),
          }),
        );
      }
      figure.append(caption);
    }
    if (quote.text) figure.append(renderMarkdown(quote.text));
    el.append(figure);
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'rc-actions';
  actionsEl.setAttribute('role', 'group');
  actionsEl.setAttribute('aria-label', 'What to do with this finding');
  actionsEl.style.setProperty('--rc-columns', String(ACTIONS_FOR[change.kind].length));
  const options = ACTIONS_FOR[change.kind].map((option) => [
    option,
    button({
      className: 'rc-action demo-focus',
      html: `${icon(iconFor(change.kind, option), { size: 14 })}${actionLabel(change.kind, option)}`,
      onClick: () =>
        review.decided(change.key) === option ? review.undo(change.key) : review.decide(change.key, option),
    }),
  ]);
  actionsEl.append(...options.map(([, optionButton]) => optionButton));
  el.append(actionsEl);

  let editor = null;

  function refresh() {
    const decided = review.decided(change.key);
    el.toggleAttribute('data-decided', Boolean(decided));
    for (const [option, optionButton] of options) {
      optionButton.classList.toggle('is-recommended', !decided && review.recommended(change.key) === option);
      optionButton.setAttribute('aria-pressed', String(decided === option));
      optionButton.title = decided === option ? 'Click again to undo' : actionHint(change.kind, option);
    }
    if (review.action(change.key) !== 'rewrite') {
      editor?.destroy();
      editor = null;
      return;
    }
    if (!editor) {
      editor = createRewriteEditorEl({
        value: review.text(change),
        label: change.kind === 'missing' ? 'Clause to insert' : 'Rewritten passage',
        onChange: (text) => review.setText(change.key, text),
        onReset: () => review.resetText(change.key),
      });
      el.append(editor.el);
    }
    editor.update(review.text(change), review.edited(change.key));
  }

  refresh();

  return { el, refresh, destroy: () => editor?.destroy() };
}
