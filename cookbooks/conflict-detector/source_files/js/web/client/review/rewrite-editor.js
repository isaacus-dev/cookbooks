import { createRewriteEditor, toHtml } from '/review/lib/redline.js';
import { button, icon } from '/review/icons.js';

export function createRewriteEditorEl({ value, label, onChange, onReset }) {
  const el = document.createElement('div');
  el.className = 're';
  el.addEventListener('click', (event) => event.stopPropagation());

  const bar = document.createElement('div');
  bar.className = 're-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');

  const bodyEl = document.createElement('div');
  bodyEl.className = 're-body';
  const rawEl = document.createElement('textarea');
  rawEl.className = 're-raw';
  rawEl.setAttribute('aria-label', `${label} (Markdown)`);
  rawEl.spellcheck = false;
  rawEl.hidden = true;

  let emitted = value;
  let raw = false;
  const markButtons = {};

  const editor = createRewriteEditor({
    element: bodyEl,
    markdown: value,
    label,
    onChange: (markdown) => {
      emitted = markdown;
      onChange(markdown);
    },
    onMarks: (marks) => {
      for (const [mark, pressed] of Object.entries(marks)) {
        markButtons[mark]?.setAttribute('aria-pressed', String(pressed));
      }
    },
  });

  for (const name of ['Bold', 'Italic']) {
    const mark = name.toLowerCase();
    markButtons[mark] = button({
      className: 're-btn demo-focus',
      label: name,
      title: `${name} (Ctrl+${name[0]})`,
      html: icon(mark, { size: 14 }),
      onClick: () => editor.chain().focus()[`toggle${name}`]().run(),
    });
    markButtons[mark].setAttribute('aria-pressed', 'false');
    bar.append(markButtons[mark]);
  }

  const resetBtn = button({
    className: 're-btn re-btn--end demo-focus',
    label: 'Reset to the suggested text',
    html: icon('rotateCcw', { size: 14 }),
    onClick: onReset,
  });

  function fit() {
    rawEl.style.height = 'auto';
    rawEl.style.height = `${rawEl.scrollHeight + 2}px`;
  }

  function show(markdown) {
    if (!raw) return editor.commands.setContent(toHtml(markdown), { emitUpdate: false });
    rawEl.value = markdown;
    fit();
  }

  const rawBtn = button({
    className: 're-btn demo-focus',
    label: 'Edit as Markdown',
    html: icon('codeXml', { size: 14 }),
    onClick: () => {
      raw = !raw;
      rawBtn.setAttribute('aria-pressed', String(raw));
      bodyEl.hidden = raw;
      rawEl.hidden = !raw;
      for (const markButton of Object.values(markButtons)) markButton.disabled = raw;
      show(emitted);
    },
  });
  rawBtn.setAttribute('aria-pressed', 'false');

  rawEl.addEventListener('input', () => {
    emitted = rawEl.value;
    fit();
    onChange(rawEl.value);
  });

  bar.append(resetBtn, rawBtn);
  el.append(bar, bodyEl, rawEl);

  return {
    el,
    update(next, canReset) {
      resetBtn.hidden = !canReset;
      rawBtn.classList.toggle('re-btn--end', !canReset);
      if (next === emitted) return;
      emitted = next;
      show(next);
    },
    destroy() {
      editor.destroy();
      el.remove();
    },
  };
}
