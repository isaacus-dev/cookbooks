function scrollToTarget(container, delta) {
  const target = Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight - container.clientHeight));
  const far = Math.abs(target - container.scrollTop) > container.clientHeight * 3;
  container.scrollTo({ top: target, behavior: far ? 'instant' : 'smooth' });
}

export function centerInContainer(el, container) {
  const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const { height } = el.getBoundingClientRect();
  scrollToTarget(container, height > container.clientHeight * 0.6 ? top - 16 : top - container.clientHeight / 2 + height / 2);
}

export function nudgeIntoContainer(el, container) {
  const box = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const delta = rect.top < box.top + 12 ? rect.top - box.top - 12 : rect.bottom > box.bottom - 12 ? rect.bottom - box.bottom + 12 : 0;
  if (delta) scrollToTarget(container, delta);
}

export function whenScrollSettles(container) {
  return new Promise((resolve) => {
    let last = container.scrollTop;
    let still = 0;
    requestAnimationFrame(function step() {
      still = container.scrollTop === last ? still + 1 : 0;
      last = container.scrollTop;
      if (still >= 3) resolve();
      else requestAnimationFrame(step);
    });
  });
}
