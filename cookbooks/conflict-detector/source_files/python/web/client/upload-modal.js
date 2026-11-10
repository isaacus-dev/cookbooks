import { h, icon } from "/demo/dom.js";

const UPLOAD_ICON = icon(["M12 15V4M8 8l4-4 4 4", "M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"]);
const megabytes = (bytes) => `${Math.floor(bytes / (1024 * 1024))}MB`;

export function createUploadModal({ limits, onSubmit }) {
  let busy = false;
  const fields = ["reference", "input"].map((side) => {
    const id = `cd-upload-${side}`;
    const input = h("input", { type: "file", id, name: id, className: "cd-upload-field__input" });
    const hint = h("p", { className: "cd-upload-field__hint", textContent: "Optional" });
    const label = h("label", { className: "cd-upload-field__label", htmlFor: id, textContent: `${side[0].toUpperCase()}${side.slice(1)} document` });
    return { input, hint, el: h("div", { className: "cd-upload-field" }, label, input, hint) };
  });
  const errorEl = h("p", { className: "cd-upload-error", role: "alert", hidden: true });
  const submitButton = h("button", { type: "submit", className: "demo-btn demo-btn--primary demo-focus" });
  const form = h("form", { className: "cd-upload-form", noValidate: true }, ...fields.map((field) => field.el), errorEl, h("div", { className: "cd-upload-actions" }, submitButton));

  const showError = (message) => {
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  };
  const setBusy = (next) => {
    busy = next;
    for (const { input } of fields) input.disabled = next;
    submitButton.disabled = next;
    submitButton.innerHTML = UPLOAD_ICON;
    submitButton.append(next ? "Uploading…" : "Upload");
  };
  setBusy(false);

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const [referenceFile, inputFile] = fields.map(({ input }) => input.files[0] ?? null);
    const { accept = [], max_bytes: maxBytes } = limits() ?? {};
    if (!referenceFile && !inputFile) return showError("Choose a reference document, an input document, or both.");
    for (const file of [referenceFile, inputFile].filter(Boolean)) {
      if (accept.length && !accept.some((ext) => file.name.toLowerCase().endsWith(ext.toLowerCase()))) {
        return showError(`${file.name} must be one of: ${accept.join(", ")}`);
      }
      if (maxBytes && file.size > maxBytes) return showError(`${file.name} exceeds the ${megabytes(maxBytes)} limit`);
    }
    setBusy(true);
    showError(null);
    try {
      await onSubmit({ referenceFile, inputFile });
    } catch (error) {
      showError(error.message);
    }
    setBusy(false);
  };

  const closeButton = h("button", {
    type: "button",
    className: "demo-dialog__close demo-focus demo-focus--inset",
    "aria-label": "Close upload files",
    innerHTML: icon(["M18 6 6 18", "m6 6 12 12"], 18),
    onclick: () => dialog.close(),
  });
  const dialog = h(
    "dialog",
    {
      className: "demo-dialog demo-dialog--default",
      "aria-labelledby": "demo-dialog-title",
      onclose: () => {
        form.reset();
        showError(null);
      },
    },
    h("div", { className: "demo-dialog__header" }, h("h2", { id: "demo-dialog-title", className: "demo-dialog__title", textContent: "Upload files" }), closeButton),
    h("div", { className: "demo-dialog__body" }, form),
  );

  const outside = (event) => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  let pressedOutside = false;
  dialog.onpointerdown = (event) => (pressedOutside = outside(event));
  dialog.onclick = (event) => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  };

  function open() {
    const { accept = [], max_bytes: maxBytes } = limits() ?? {};
    const parts = [...(accept.length ? [accept.join(", ")] : []), ...(maxBytes ? [`up to ${megabytes(maxBytes)}`] : [])];
    for (const { input, hint } of fields) {
      hint.textContent = `Optional${parts.length ? ` — ${parts.join(", ")}` : ""}`;
      input.accept = accept.join(",");
    }
    dialog.showModal();
  }

  return { el: dialog, open, close: () => dialog.close() };
}
