export function createChrome() {
  const listeners = new Set();
  const chrome = {
    drawer: null,
    isWide: false,
    columns: undefined,
    set(next) {
      if (Object.keys(next).every((key) => chrome[key] === next[key])) return;
      Object.assign(chrome, next);
      for (const fn of listeners) fn();
    },
    openDrawer: (drawer) => chrome.set({ drawer }),
    close: () => chrome.set({ drawer: null }),
    subscribe: (fn) => listeners.add(fn),
  };
  return chrome;
}
