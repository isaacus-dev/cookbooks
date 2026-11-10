import { getCatalog, getRun, uploadDocuments, getAnalysisStatus, pollAnalysisUntilDone, startAnalysis } from "/api.js";
import { createChrome } from "/demo/chrome.js";
import { createEmbed } from "/demo/embed.js";
import { createPicker } from "/demo/picker.js";
import { createDocumentViewer } from "/demo/document-viewer.js";
import { buildMarkdownBlocks } from "/demo/markdown.js";
import { createFindingsPanel } from "/demo/findings-panel.js";
import { createSidebarDocument } from "/demo/sidebar-document.js";
import { buildOutlineTree, topLevelIds, createOutlineNav, createOutlineRail } from "/demo/outline.js";
import { centerInContainer, nudgeIntoContainer, whenScrollSettles } from "/demo/scroll.js";
import { h, icon } from "/demo/dom.js";
import { createUploadModal } from "/upload-modal.js";
import { ACCENTS, FILTERS, MARK_TITLES, collectSpans, findingRows } from "/conflict-run.js";

const STAGES = ["Reading documents", "Matching", "Classifying", "Comparing", "Assembling report", "Saving results", "Summarizing and recommending"];
const PANEL_SHAPES = [
  { id: "toc", side: "left", width: "rail", expandedWidth: "narrow" },
  { id: "findings", side: "right", width: "narrow", expandedWidth: "wide" },
];
const DEFAULT_REFERENCE = "samples/03-common-paper-cloud-service-agreement.md";
const DEFAULT_INPUT = "samples/04-mistral-ai-terms-of-use.md";

const state = {
  catalog: null,
  referencePath: null,
  inputPath: null,
  run: null,
  screen: "loading",
  selectedKey: null,
  sidebarFilter: "deviation",
  tocExpanded: null,
  referenceOpen: false,
  progress: null,
  finished: false,
  cachedRun: false,
  error: null,
};

let outlineItems = [];
let fadedOut = null;
let shownSidebarEl = null;
let tourHighlight = null;
const inputMarks = new Map();
const previewMarks = new Map();
const cards = new Map();
const chrome = createChrome();

const addMark = (marks) => (node, keys) => {
  for (const key of keys) if (!marks.has(key)) marks.set(key, node);
};

function titleOf(path) {
  const doc = ["reference", "input"].flatMap((side) => state.catalog?.[side]?.documents ?? []).find((entry) => entry.path === path);
  return doc?.title || doc?.name || path;
}

const button = (textContent, onClick) =>
  h("button", { type: "button", className: "demo-btn demo-btn--primary demo-focus", textContent, onclick: () => void onClick() });

function documentOptions(side) {
  return (state.catalog?.[side]?.documents ?? []).map((doc) => ({
    value: doc.path,
    label: doc.title || doc.name,
    group: doc.origin_label || doc.origin,
  }));
}

function restartFlash(node, animation) {
  node.classList.remove("is-flash");
  void node.offsetWidth;
  node.classList.add("is-flash");
  node.addEventListener("animationend", function done(event) {
    if (event.animationName !== animation) return;
    node.classList.remove("is-flash");
    node.removeEventListener("animationend", done);
  });
}

async function flash(body, key) {
  await whenScrollSettles(body);
  for (const para of body.querySelectorAll(".demo-doc__para--bar")) {
    if (para.dataset.keys.split(" ").includes(key)) restartFlash(para, "demo-bar-flash");
  }
}

async function selectKey(key) {
  state.selectedKey = key;
  state.sidebarFilter = key[0] === "d" ? "deviation" : key[0] === "r" ? "gap_reference" : "gap_input";
  render();
  await new Promise(requestAnimationFrame);

  if (inputMarks.has(key)) centerInContainer(inputMarks.get(key), viewer.bodyEl);
  if (previewMarks.has(key)) centerInContainer(previewMarks.get(key), referenceDoc.bodyEl);
  const card = cards.get(key);
  if (card) {
    const group = card.closest(".demo-findings__group");
    nudgeIntoContainer(group && group.offsetHeight <= findings.listEl.clientHeight ? group : card, findings.listEl);
  }
}

function selectMark(key) {
  void selectKey(key).then(async () => {
    const card = cards.get(key);
    if (!card) return;
    await whenScrollSettles(findings.listEl);
    restartFlash(card, "demo-row-flash");
  });
}

async function scrollToSection(offset) {
  chrome.close();
  const body = viewer.bodyEl;
  const blocks = [...body.querySelectorAll("[data-demo-block]")];
  const block = blocks.findLast((el) => Number(el.dataset.demoBlock) <= Number(offset)) ?? blocks[0];
  if (!block) return;
  centerInContainer(block, body);
  await whenScrollSettles(body);
  restartFlash(block, "demo-block-flash");
}

async function loadPair() {
  if (!state.referencePath || !state.inputPath) return;
  if (!state.run) state.screen = "loading";
  Object.assign(state, { selectedKey: null, tocExpanded: null, error: null });
  render();

  const main = embed.contentEl.closest(".demo-app__main");
  let faded;
  if (state.run && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    fadedOut?.cancel();
    fadedOut = main.animate({ opacity: [1, 0.15] }, { duration: 160, easing: "ease-out", fill: "forwards" });
    faded = fadedOut.finished.catch(() => {});
  }

  try {
    const [run] = await Promise.all([getRun(state.referencePath, state.inputPath), faded]);
    state.run = run;
    state.screen = run ? "results" : "empty";
  } catch (error) {
    Object.assign(state, { run: null, error: error.message, screen: "empty" });
  }
  render();
  if (fadedOut) {
    fadedOut.cancel();
    fadedOut = null;
    main.animate({ opacity: [0.15, 1] }, { duration: 240, easing: "ease-out" });
  }
  if (state.screen === "results") embed.tour.startIfUnseen();
}

function setDocument(side, path) {
  const [key, otherKey] = side === "reference" ? ["referencePath", "inputPath"] : ["inputPath", "referencePath"];
  if (path === state[otherKey]) {
    state[otherKey] = state[key];
    embed.showNotice("Swapped the input and reference documents.");
  }
  state[key] = path;
  void loadPair();
}

function onAnalysisEvent(event) {
  if (event.type === "status") {
    const stage = STAGES.indexOf(String(event.message ?? "").replace(/…$/, ""));
    state.progress = { ...state.progress, message: event.message, ...(stage === -1 ? {} : { stage, done: null, total: null }) };
  } else if (event.type === "progress") {
    state.progress = { ...state.progress, done: event.done, total: event.total };
  } else if (event.type === "started") {
    state.progress = { message: "Starting…", stage: -1 };
  } else if (event.type === "ready" && event.cached) {
    state.cachedRun = true;
  }
  render();
}

async function runPair() {
  Object.assign(state, { screen: "running", progress: { message: "Starting…", stage: -1 }, finished: false, cachedRun: false, error: null });
  render();
  try {
    await startAnalysis({ reference_path: state.referencePath, input_path: state.inputPath }, onAnalysisEvent);
    state.catalog = await getCatalog();
    if (state.cachedRun) return await loadPair();
    state.finished = true;
    state.progress = { ...state.progress, message: "Analysis complete" };
  } catch (error) {
    state.error = error.message;
    state.screen = "empty";
  }
  render();
}

function openReference(key = null) {
  state.referenceOpen = true;
  render();
  if (key) void selectKey(key).then(() => flash(referenceDoc.bodyEl, key));
}

function closeReference() {
  if (!state.referenceOpen) return;
  state.referenceOpen = false;
  render();
}

const referencePicker = createPicker({ label: "Reference document", onChange: (path) => setDocument("reference", path) });
const inputPicker = createPicker({
  label: "Input document",
  className: "cd-header-picker",
  plain: true,
  onChange: (path) => setDocument("input", path),
});

const previewButton = h("button", {
  type: "button",
  className: "demo-icon-btn demo-focus",
  "aria-label": "View full document",
  title: "View full document",
  innerHTML: icon(["M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "M14 2v5a1 1 0 0 0 1 1h5", "M10 9H8", "M16 13H8", "M16 17H8"]),
  onclick: () => openReference(),
});
const findingsHeader = h("div", { className: "cd-reference-row", "data-tour": "reference" }, referencePicker.el, previewButton);

const viewer = createDocumentViewer({
  markAccents: ACCENTS,
  markTitles: MARK_TITLES,
  onSelectMark: selectMark,
  onHoverKey: (key) => {
    findings.setHoverKey(key);
    referenceDoc.setHoverKey(key);
  },
  registerMark: addMark(inputMarks),
});

const findings = createFindingsPanel({
  headerEl: findingsHeader,
  onSelectFilter: (id) => {
    state.sidebarFilter = id;
    render();
  },
  onSelectRow: (key) => {
    chrome.close();
    void selectKey(key).then(() => flash(viewer.bodyEl, key));
  },
  onHoverRow: (key) => viewer.setHoverKey(key),
  onAction: (row) => openReference(row.keys?.includes(state.selectedKey) ? state.selectedKey : row.key),
  registerRow: (node, keys) => {
    for (const key of keys) cards.set(key, node);
  },
});

const outlineNav = createOutlineNav({
  onSelect: scrollToSection,
  onToggle: (id) => {
    const expanded = new Set(state.tocExpanded ?? topLevelIds(outlineItems));
    if (!expanded.delete(id)) expanded.add(id);
    state.tocExpanded = [...expanded];
    render();
  },
});
const outlineRail = createOutlineRail({ onSelect: scrollToSection, getContainer: () => viewer.bodyEl });

const referenceDoc = createSidebarDocument({
  backLabel: "Findings",
  onBack: closeReference,
  markAccents: ACCENTS,
  markTitles: MARK_TITLES,
  onSelectMark: selectMark,
  onHoverKey: (key) => viewer.setHoverKey(key),
  registerMark: addMark(previewMarks),
});

const uploadModal = createUploadModal({
  limits: () => state.catalog?.upload,
  onSubmit: async (files) => {
    const result = await uploadDocuments(files);
    state.catalog = result;
    for (const saved of result.uploaded ?? []) {
      if (saved.side === "reference") state.referencePath = saved.path;
      if (saved.side === "input") state.inputPath = saved.path;
    }
    uploadModal.close();
    void runPair();
  },
});

const TOUR = {
  id: "conflict",
  steps: [
    {
      target: ".cd-header-picker",
      enter: closeReference,
      title: "Pick an input document",
      body: "The document you want to check. You'll compare it against a reference document.",
    },
    {
      target: '[data-tour="reference"]',
      panel: "findings",
      title: "Pick a reference document",
      body: "The document you'll compare the input document against.",
    },
    {
      target: '[data-tab="deviation"]',
      panel: "findings",
      enter: () => {
        state.referenceOpen = false;
        state.sidebarFilter = "deviation";
        render();
      },
      title: "Deviations",
      body: "Provisions in both documents that cover the same topic, but say something different about it.",
    },
    {
      target: () => inputMarks.get(tourHighlight) ?? null,
      enter: () => {
        Object.assign(state, { referenceOpen: false, selectedKey: null, sidebarFilter: "deviation" });
        render();
        const report = state.run?.report;
        tourHighlight = report ? (findingRows(report, "deviation")[0]?.key ?? null) : null;
        if (inputMarks.has(tourHighlight)) centerInContainer(inputMarks.get(tourHighlight), viewer.bodyEl);
        findings.listEl.scrollTo({ top: 0 });
      },
      await: true,
      title: "Click the highlight",
      body: "Each highlight in the input document is a finding. Click this one to see its deviation.",
    },
    {
      target: () => cards.get(state.selectedKey) ?? null,
      panel: "findings",
      title: "The deviation",
      body: "A summary of how the two provisions differ, then the reference provision the input was matched with.",
    },
    {
      target: ".demo-row.is-active .demo-row__action",
      panel: "findings",
      enter: closeReference,
      await: true,
      title: "View the full clause",
      body: 'Click "View full clause" to open the reference document at the matched provision.',
    },
    {
      target: ".demo-sidebar-doc__back",
      panel: "findings",
      await: true,
      title: "The reference document",
      body: 'The matched text is highlighted below. Click "Findings" to go back.',
    },
    {
      target: '[data-tab="gap_reference"]',
      panel: "findings",
      enter: closeReference,
      await: true,
      title: "Reference gaps",
      body: "Provisions in the reference document that the input document doesn't cover. Click the tab to see them.",
    },
    {
      target: '[data-tab="gap_input"]',
      panel: "findings",
      await: true,
      title: "Input gaps",
      body: "Provisions in the input document that the reference document doesn't cover. Click the tab to see them.",
    },
  ],
};

const reviewLink = h("a", { className: "demo-btn demo-btn--ghost demo-focus", textContent: "Review", title: "Keep, remove or rewrite each finding" });

const embed = createEmbed({
  chrome,
  tour: TOUR,
  className: "cd-tokens",
  headerExtraEl: inputPicker.el,
  actionsExtraEl: reviewLink,
  onUpload: () => uploadModal.open(),
  expandAt: 1180,
  contentMaxWidth: "42rem",
  headerPanels: PANEL_SHAPES,
});

function render() {
  const report = state.run?.report;
  inputMarks.clear();
  previewMarks.clear();
  cards.clear();

  inputPicker.update({ value: state.inputPath, options: documentOptions("input") });
  referencePicker.update({ value: state.referencePath, options: documentOptions("reference") });
  reviewLink.href = `/review.html?${new URLSearchParams({ reference: state.referencePath ?? "", input: state.inputPath ?? "" })}`;

  outlineItems = report ? buildOutlineTree(report.input.sections.map(({ start, title, level }) => ({ id: start, title, level }))) : [];
  outlineNav.update({ items: outlineItems, expandedIds: state.tocExpanded ?? topLevelIds(outlineItems) });
  outlineRail.update({ items: outlineItems });

  const inputBlocks = report && buildMarkdownBlocks(state.run.input_text, collectSpans(report, "input"));
  const referenceBlocks = report && buildMarkdownBlocks(state.run.reference_text, collectSpans(report, "reference"));
  if (report) {
    findings.update({
      filters: FILTERS.map(({ id, label, list }) => ({ id, label, count: report[list].length, accent: ACCENTS[id] })),
      activeFilter: state.sidebarFilter,
      rows: findingRows(report, state.sidebarFilter, {
        input: { text: state.run.input_text, blocks: inputBlocks },
        reference: { text: state.run.reference_text, blocks: referenceBlocks },
      }),
      activeKey: state.selectedKey,
    });
    viewer.update({ blocks: inputBlocks, activeKey: state.selectedKey });
  } else {
    findings.update({ filters: [], rows: [], activeKey: null });
  }

  if (state.referenceOpen) {
    const doc = state.catalog?.reference?.documents?.find((entry) => entry.path === state.referencePath);
    referenceDoc.update({ title: doc?.title || doc?.name || "Reference document", blocks: referenceBlocks, activeKey: state.selectedKey });
  }

  const results = state.screen === "results" && Boolean(report);
  let body = viewer.el;
  if (state.screen === "loading") body = h("p", { className: "cd-status", textContent: "Loading cached results…" });
  else if (state.screen === "running") {
    const current = state.finished ? STAGES.length : (state.progress?.stage ?? -1);
    const { done, total, message } = state.progress ?? {};
    body = h(
      "div",
      { className: "cd-progress" },
      h("p", { className: "cd-progress__label", textContent: `Analyzing ${titleOf(state.inputPath)} against ${titleOf(state.referencePath)}` }),
      h(
        "ol",
        { className: "cd-steps" },
        ...STAGES.map((stage, index) => {
          const step = index < current ? "done" : index === current ? "active" : "pending";
          const item = h(
            "li",
            { className: `cd-step cd-step--${step}` },
            h("span", { className: "cd-step__mark", "aria-hidden": "true" }),
            h("span", { textContent: step === "active" && total ? `${stage} — ${done}/${total}` : stage }),
          );
          if (step === "active") item.setAttribute("aria-current", "step");
          return item;
        }),
      ),
    );
    if (current < 0) body.append(h("p", { className: "cd-progress__message", textContent: message ?? "Working" }));
    if (state.finished) body.append(h("div", { className: "cd-progress__actions" }, button("View results", loadPair)));
  } else if (!results) {
    const same = !state.error && state.referencePath === state.inputPath;
    body = h(
      "div",
      { className: "cd-unbundled" },
      h("h2", {
        className: "cd-unbundled__title",
        textContent: state.error ? "That run could not be loaded" : same ? "You can't compare the same document to itself" : "We've not run this pair",
      }),
      h("p", {
        className: "cd-unbundled__text",
        textContent:
          state.error ||
          (same
            ? "Choose a different document on one side."
            : `${titleOf(state.referencePath)} against ${titleOf(state.inputPath)} has no saved run. ` +
              "Running it calls the API and takes a few minutes; the result is then cached for this pairing."),
      }),
      h("p", { className: "cd-unbundled__caption", textContent: "Findings come from a saved run on disk. Upload your own documents to run a new pairing." }),
    );
    if (!same) body.append(h("div", { className: "cd-unbundled__actions" }, button("Run this pairing", runPair)));
  }
  embed.contentEl.replaceChildren(body);

  const sidebarEl = state.referenceOpen && report ? referenceDoc.el : findings.el;
  embed.update({
    fillHeight: results,
    panels:
      state.screen === "running"
        ? []
        : [
            { ...PANEL_SHAPES[0], label: "Contents", bodyEl: outlineNav.el, columnBodyEl: outlineRail.el, iconSvg: icon(["M4 6h16M4 12h16M4 18h10"], 16, 2) },
            { ...PANEL_SHAPES[1], label: "Findings", bodyEl: sidebarEl, showLabelWhenWide: false },
          ],
  });

  if (shownSidebarEl && sidebarEl !== shownSidebarEl && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const from = sidebarEl === referenceDoc.el ? "12px 0" : "-12px 0";
    sidebarEl.animate({ opacity: [0, 1], translate: [from, "0 0"] }, { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  }
  shownSidebarEl = sidebarEl;
}

async function boot() {
  document.getElementById("app").append(embed.el);
  document.body.append(uploadModal.el);
  render();

  const catalog = (state.catalog = await getCatalog());
  const listed = (side, path) => (catalog[side]?.documents ?? []).some((doc) => doc.path === path);
  const params = new URLSearchParams(location.search);
  const cached = Object.values(catalog.pairs ?? {})
    .filter((entry) => entry.reference_path && entry.input_path)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  [state.referencePath, state.inputPath] =
    listed("reference", params.get("reference")) && listed("input", params.get("input"))
      ? [params.get("reference"), params.get("input")]
      : listed("reference", DEFAULT_REFERENCE) && listed("input", DEFAULT_INPUT)
        ? [DEFAULT_REFERENCE, DEFAULT_INPUT]
        : cached
          ? [cached.reference_path, cached.input_path]
          : [catalog.reference?.documents?.[0]?.path ?? null, catalog.input?.documents?.[0]?.path ?? null];

  const status = await getAnalysisStatus().catch(() => null);
  if (status?.state === "running") {
    state.screen = "running";
    state.progress = { message: status.message ?? "Analyzing…" };
    render();
    await pollAnalysisUntilDone(onAnalysisEvent);
    state.catalog = await getCatalog();
  }
  await loadPair();
}

void boot();
