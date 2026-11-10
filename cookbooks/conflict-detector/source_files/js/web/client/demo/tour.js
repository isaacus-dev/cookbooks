import { h } from '/demo/dom.js';

const GAP = 10;
const EDGE = 12;
const ACTIVE_ATTR = 'data-demo-tour-target';

const iconButton = (className, label, path) =>
  h('button', {
    type: 'button',
    className: `${className} demo-focus`,
    'aria-label': label,
    title: label,
    innerHTML: `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="${path}" /></svg>`
  });

export function createTour({ frameEl, chrome, id, steps, panelLabel, onChange }) {
  const storageKey = `demo-tour:${id}`;
  const skipBtn = iconButton('demo-tour__skip', 'Skip tour', 'm4 4 8 8M12 4l-8 8');
  const titleEl = h('h2', { className: 'demo-tour__title', id: 'demo-tour-title' });
  const bodyEl = h('p', { className: 'demo-tour__body' });
  const hintEl = h('p', { className: 'demo-tour__body' });
  const countEl = h('small', { className: 'demo-tour__count' });
  const dots = steps.map(() => h('span'));
  const progressEl = h('div', { className: 'demo-tour__progress' }, countEl, ...dots);
  const backBtn = iconButton('demo-tour__icon', 'Previous step', 'm9.5 3.5-4 4 4 4');
  const nextBtn = iconButton('demo-tour__icon demo-tour__icon--next', 'Next step', 'm6.5 3.5 4 4-4 4');
  const el = h(
    'div',
    { className: 'demo-tour', role: 'dialog', 'aria-labelledby': 'demo-tour-title', hidden: true },
    skipBtn,
    titleEl,
    bodyEl,
    hintEl,
    h('footer', { className: 'demo-tour__actions' }, progressEl, h('div', { className: 'demo-tour__nav' }, backBtn, nextBtn))
  );
  frameEl.append(el);

  let index = null;
  let target = null;
  let frame = 0;
  let stopWaiting = null;

  const isVisible = (node) => node instanceof HTMLElement && node.getClientRects().length > 0;

  async function findTarget(step) {
    const deadline = performance.now() + 1500;
    for (;;) {
      const node = typeof step.target === 'function' ? step.target() : frameEl.querySelector(step.target);
      if (isVisible(node)) return node;
      const toggle = step.panel && !chrome.isWide && frameEl.querySelector(`[data-demo-panel-toggle="${step.panel}"]`);
      if (isVisible(toggle)) return toggle;
      if (performance.now() > deadline) return null;
      await new Promise(requestAnimationFrame);
    }
  }

  function place() {
    const bounds = frameEl.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const card = el.getBoundingClientRect();
    const top = rect.top - bounds.top;
    const bottom = rect.bottom - bounds.top;
    const fitsBelow = bottom + GAP + card.height <= bounds.height - EDGE;
    const y = fitsBelow || top - GAP - card.height < EDGE ? bottom + GAP : top - GAP - card.height;
    const x = rect.left - bounds.left + rect.width / 2 - card.width / 2;
    el.style.top = `${Math.min(Math.max(y, EDGE), bounds.height - card.height - EDGE)}px`;
    el.style.left = `${Math.min(Math.max(x, EDGE), bounds.width - card.width - EDGE)}px`;
    el.classList.add('is-placed');
  }

  function advance() {
    if (index === steps.length - 1) close();
    else void show(index + 1, 1);
  }

  function release() {
    cancelAnimationFrame(frame);
    stopWaiting?.();
    stopWaiting = null;
    target?.removeAttribute(ACTIVE_ATTR);
    target = null;
    el.classList.remove('is-placed');
  }

  function close() {
    if (index === null) return;
    release();
    index = null;
    el.hidden = true;
    try {
      localStorage.setItem(storageKey, '1');
    } catch {}
    onChange?.(false);
  }

  async function show(i, direction = 1) {
    release();
    index = i;
    onChange?.(true);
    const step = steps[i];
    chrome.close();
    await step.enter?.();
    const node = await findTarget(step);
    if (index !== i) return;
    if (!node) {
      const skipTo = i + direction;
      if (skipTo < 0 || skipTo >= steps.length) close();
      else void show(skipTo, direction);
      return;
    }

    const hint = node.matches('[data-demo-panel-toggle]') ? panelLabel(step.panel) : null;
    countEl.textContent = `${i + 1}/${steps.length}`;
    progressEl.setAttribute('aria-label', `Step ${i + 1} of ${steps.length}`);
    dots.forEach((dot, n) => {
      dot.classList.toggle('is-current', n === i);
      dot.classList.toggle('is-done', n < i);
    });
    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    hintEl.hidden = !hint;
    if (hint) hintEl.replaceChildren('Open ', h('strong', { textContent: hint }), ' to see it.');
    const waits = Boolean(step.await) && !hint;
    const isLast = i === steps.length - 1;
    backBtn.hidden = i === 0;
    nextBtn.disabled = waits;
    nextBtn.setAttribute('aria-label', isLast ? 'Finish tour' : 'Next step');
    nextBtn.title = waits ? 'Do the step above to continue' : isLast ? 'Finish tour' : 'Next step';

    const hadFocus = frameEl.contains(document.activeElement);
    el.hidden = false;
    if (typeof step.target !== 'function') node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target = node;
    if (waits) {
      const onClick = (event) => {
        if (node.contains(event.target)) setTimeout(() => index === i && advance());
      };
      const onKey = (event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick(event);
      };
      frameEl.addEventListener('click', onClick, true);
      frameEl.addEventListener('keydown', onKey, true);
      stopWaiting = () => {
        frameEl.removeEventListener('click', onClick, true);
        frameEl.removeEventListener('keydown', onKey, true);
      };
    }
    target.setAttribute(ACTIVE_ATTR, '');
    frame = requestAnimationFrame(function loop() {
      place();
      frame = requestAnimationFrame(loop);
    });
    if (hadFocus && !waits) nextBtn.focus({ preventScroll: true });
  }

  skipBtn.onclick = close;
  backBtn.onclick = () => index !== null && void show(index - 1, -1);
  nextBtn.onclick = () => index !== null && advance();

  return {
    start: () => void show(0),
    startIfUnseen: () => {
      let seen = false;
      try {
        seen = localStorage.getItem(storageKey) === '1';
      } catch {}
      if (index === null && !seen) void show(0);
    },
    close,
    get isOpen() {
      return index !== null;
    }
  };
}
