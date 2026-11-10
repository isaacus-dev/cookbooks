import { getCatalog, getReviews, getRun, startReviews } from "/api.js";
import { createChrome } from "/demo/chrome.js";
import { createEmbed } from "/demo/embed.js";
import { createPicker } from "/demo/picker.js";
import { createSidebarDocument } from "/demo/sidebar-document.js";
import { buildOutlineTree, topLevelIds, createOutlineNav, createOutlineRail } from "/demo/outline.js";
import { buildMarkdownBlocks } from "/demo/markdown.js";
import { centerInContainer, whenScrollSettles } from "/demo/scroll.js";
import { ACTIONS_FOR, REVIEW_ACCENTS, exportPdf } from "/review/lib/redline.js";
import { createOpenCard, renderListCard } from "/review/card.js";
import { renderChanges } from "/review/changes.js";
import { createRedlineDoc } from "/review/doc.js";
import { button, icon } from "/review/icons.js";
import { createReviewState } from "/review/state.js";

const KINDS = [
  { id: "changed", label: "Deviations" },
  { id: "missing", label: "Reference" },
  { id: "added", label: "Input" },
];

const PANEL_SHAPES = [
  { id: "toc", side: "left", width: "rail", expandedWidth: "narrow" },
  { id: "findings", side: "right", width: "wide" },
];

const TOC_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

const state = {
  catalog: null,
  reference: null,
  input: null,
  screen: "loading",
  error: null,
  reviewsMissing: false,
  generating: null,
  currentKey: null,
  view: "findings",
  focused: true,
  kinds: ["changed", "missing", "added"],
  showReviewed: false,
  filterOpen: false,
  clearArmed: false,
  referenceKey: null,
  exporting: false,
  tocExpanded: null,
};

let outlineItems = [];
let focusBox = null;
const chrome = createChrome();
const review = createReviewState((key) => {
  if (key) doc.paint(key);
  else doc.render();
  render();
});

const shown = () => review.unfiltered.filter((change) => state.kinds.includes(change.kind));
const visibleList = () =>
  state.showReviewed
    ? shown()
    : shown().filter((change) => !review.decided(change.key) || change.key === state.currentKey);
const current = () => visibleList().find((change) => change.key === state.currentKey);
const referenceQuotes = (change) => (change ? review.quotes(change).filter((quote) => quote.span) : []);
const pairQuery = () => new URLSearchParams({ reference: state.reference ?? "", input: state.input ?? "" });
const entryOf = (path) =>
  ["reference", "input"].flatMap((side) => state.catalog?.[side]?.documents ?? []).find((entry) => entry.path === path);

const doc = createRedlineDoc(review, (change) => void select(change, "doc"));
const bodyEl = document.createElement("div");
bodyEl.className = "rd-body demo-scroll";
bodyEl.tabIndex = 0;
bodyEl.setAttribute("role", "region");
bodyEl.setAttribute("aria-label", "Input document under review");
bodyEl.append(doc.el);

const listEl = document.createElement("div");
listEl.className = "rd-list demo-scroll";

function scrollTo(container, target, offset, smooth) {
  if (!target) return;
  const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - offset;
  const near = Math.abs(delta) <= container.clientHeight * 3;
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  container.scrollBy({ top: delta, behavior: smooth && near && motion ? "smooth" : "instant" });
}

async function flash(container, els) {
  await whenScrollSettles(container);
  for (const el of els) {
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
    el.onanimationend = (event) => event.animationName.endsWith("-flash") && el.classList.remove("is-flash");
  }
}

async function select(change, from = "keys") {
  if (!change) return;
  state.referenceKey = null;
  if (!state.kinds.includes(change.kind)) state.kinds = [...state.kinds, change.kind];
  state.currentKey = change.key;
  state.view = "findings";
  state.focused = true;
  if (!chrome.isWide) chrome.openDrawer("findings");
  render();
  listEl.scrollTo({ top: 0 });
  if (from === "doc") return;
  focusBox?.el.focus({ preventScroll: true });
  const el = doc.passage(change.key);
  scrollTo(bodyEl, el, 64, true);
  if (el) void flash(bodyEl, [el]);
}

function step(by) {
  const list = visibleList();
  const index = list.findIndex((change) => change.key === state.currentKey);
  void select(list[(index + by + list.length) % list.length]);
}

function backToList() {
  state.referenceKey = null;
  state.focused = false;
  state.view = "findings";
  render();
  if (state.currentKey) scrollTo(listEl, listEl.querySelector(`[data-card="${state.currentKey}"]`), 8, false);
}

function onKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"]')) {
    return;
  }
  const change = current();
  const key = event.key.toLowerCase();
  const pick = !change
    ? undefined
    : /^[1-3]$/.test(key)
      ? ACTIONS_FOR[change.kind][key - 1]
      : key === "enter" && event.target.tagName !== "BUTTON"
        ? review.recommended(change.key)
        : undefined;
  if (key === "escape" && state.focused) backToList();
  else if (key === "j" || (state.focused && key === "arrowright")) step(1);
  else if (key === "k" || (state.focused && key === "arrowleft")) step(-1);
  else if (pick) {
    review.decide(change.key, pick);
    const list = visibleList();
    const at = list.findIndex((entry) => entry.key === change.key);
    void select([...list.slice(at + 1), ...list.slice(0, at + 1)].find((entry) => !review.decided(entry.key)));
  } else if (change && key === "u") review.undo(change.key);
  else return;
  event.preventDefault();
}

const referenceDoc = createSidebarDocument({
  backLabel: "Finding",
  onBack: () => {
    state.referenceKey = null;
    render();
  },
  markAccents: REVIEW_ACCENTS,
  markStyle: "bar",
});

const pickersEl = document.createElement("div");
pickersEl.className = "cdx-pickers";
const pickers = ["input", "reference"].map((side) => {
  const name = side[0].toUpperCase() + side.slice(1);
  const picker = createPicker({
    label: `${name} document`,
    prefix: name,
    hideLabel: true,
    plain: true,
    onChange: (path) => {
      const other = side === "input" ? "reference" : "input";
      if (path === state[other]) {
        state[other] = state[side];
        embed.showNotice("Swapped the input and reference documents.");
      }
      state[side] = path;
      void loadPair();
    },
  });
  const wrap = document.createElement("div");
  wrap.className = "cdx-picker";
  wrap.dataset.tour = side;
  wrap.append(picker.el);
  pickersEl.append(wrap);
  return [side, picker];
});

const partyPicker = createPicker({
  label: "Party you act for",
  prefix: "Reviewing for",
  hideLabel: true,
  searchable: false,
  className: "rd-party",
  onChange: (party) => review.setParty(party),
});

const filterBtn = button({
  className: "rd-tool demo-icon-btn demo-focus",
  label: "Filter findings",
  html: icon("listFilter", { strokeWidth: 1.8 }),
  onClick: () => {
    state.filterOpen = !state.filterOpen;
    render();
  },
});
filterBtn.setAttribute("aria-haspopup", "menu");

function filterItem(label, onClick, accent) {
  const item = button({
    className: "rd-filter__item demo-focus",
    html: `<span class="rd-filter__check">${icon("check", { size: 14 })}</span>${accent ? `<span class="rd-filter__dot" style="--rd-dot: ${accent}"></span>` : ""}`,
    onClick: () => {
      onClick();
      render();
    },
  });
  item.setAttribute("role", "menuitemcheckbox");
  item.append(label);
  return item;
}

const kindItems = KINDS.map((kind) =>
  filterItem(
    kind.label,
    () => {
      state.kinds = state.kinds.includes(kind.id)
        ? state.kinds.filter((id) => id !== kind.id)
        : KINDS.map(({ id }) => id).filter((id) => id === kind.id || state.kinds.includes(id));
      listEl.scrollTo({ top: 0 });
    },
    REVIEW_ACCENTS[kind.id],
  ),
);
const reviewedItem = filterItem("Reviewed", () => (state.showReviewed = !state.showReviewed));
const divider = document.createElement("div");
divider.className = "rd-filter__divider";
divider.setAttribute("role", "separator");
const filterMenu = document.createElement("div");
filterMenu.className = "rd-filter__menu";
filterMenu.setAttribute("role", "menu");
filterMenu.setAttribute("aria-label", "Filter findings");
filterMenu.append(...kindItems, divider, reviewedItem);

const filterEl = document.createElement("div");
filterEl.className = "rd-filter";
filterEl.append(filterBtn, filterMenu);

function closeFilter(event) {
  if (!state.filterOpen || (event.type === "keydown" ? event.key !== "Escape" : filterEl.contains(event.target))) return;
  state.filterOpen = false;
  render();
}
document.addEventListener("pointerdown", closeFilter, true);
document.addEventListener("keydown", closeFilter);

const historyBtn = button({
  className: "rd-history rd-tool demo-icon-btn demo-focus",
  label: "Change history",
  html: icon("history", { strokeWidth: 1.8 }),
  onClick: () => {
    state.referenceKey = null;
    state.view = state.view === "changes" ? "findings" : "changes";
    state.focused = false;
    state.clearArmed = false;
    render();
  },
});

const exportBtn = button({
  className: "demo-btn demo-btn--outline demo-focus",
  html: `${icon("fileDown", { size: 15, strokeWidth: 1.8 })}<span class="demo-app__upload-label">Export PDF</span>`,
  onClick: async () => {
    state.exporting = true;
    render();
    try {
      await exportPdf(review.cleanMarkdown(), state.input?.split("/").pop()?.replace(/\.md$/, "") ?? "document");
    } finally {
      state.exporting = false;
      render();
    }
  },
});
exportBtn.dataset.tour = "export";

const findingsLink = document.createElement("a");
findingsLink.className = "demo-btn demo-btn--ghost demo-focus";
findingsLink.textContent = "Findings";
findingsLink.title = "The findings page for this pair";

const actionsEl = document.createElement("div");
actionsEl.className = "rd-actions";
actionsEl.append(findingsLink, exportBtn);

function scrollToSection(offset) {
  chrome.close();
  const anchor = bodyEl.querySelector(`[data-level] [data-demo-block="${offset}"]`);
  scrollTo(bodyEl, anchor?.closest("[data-level]"), 16, true);
}

const outlineNav = createOutlineNav({
  onSelect: scrollToSection,
  onToggle: (id) => {
    const expanded = new Set(state.tocExpanded ?? topLevelIds(outlineItems));
    if (!expanded.delete(id)) expanded.add(id);
    state.tocExpanded = [...expanded];
    render();
  },
});

const outlineRail = createOutlineRail({ onSelect: scrollToSection, getContainer: () => bodyEl });

async function loadReviews() {
  const reviews = await getReviews(state.reference, state.input).catch(() => null);
  state.reviewsMissing = !reviews || !Object.keys(reviews.findings).length;
  review.setReviews(reviews ?? undefined);
}

async function loadPair() {
  if (!state.reference || !state.input) return;
  Object.assign(state, { screen: "loading", error: null, generating: null });
  history.replaceState(null, "", `?${pairQuery()}`);
  render();
  try {
    const run = await getRun(state.reference, state.input);
    review.setRun(run ? { report: run.report, reference: run.reference_text, input: run.input_text } : undefined);
    Object.assign(state, {
      screen: run ? "results" : "empty",
      currentKey: null,
      referenceKey: null,
      view: "findings",
      focused: true,
    });
    if (run) await loadReviews();
  } catch (error) {
    review.setRun(undefined);
    Object.assign(state, { error: error.message, screen: "empty" });
  }
  render();
  if (state.screen === "results") embed.tour.startIfUnseen();
}

const sideEl = document.createElement("div");
sideEl.className = "rd-side";
const topSlot = document.createElement("div");
topSlot.className = "rd-side__top";
topSlot.append(partyPicker.el, filterEl, historyBtn);
const noteSlot = document.createElement("div");
const navSlot = document.createElement("div");
navSlot.className = "rd-nav";
const leftSlot = document.createElement("p");
leftSlot.className = "rd-left";
leftSlot.setAttribute("aria-live", "polite");
sideEl.append(topSlot, noteSlot, navSlot, listEl);

const backButton = () =>
  button({
    className: "rd-back demo-focus",
    title: "Back to the findings (Esc)",
    html: `${icon("arrowLeft", { size: 14 })}Findings`,
    onClick: backToList,
  });

function heading(text, className = "rd-heading") {
  const h = document.createElement("h4");
  h.className = className;
  h.textContent = text;
  return h;
}

function render() {
  for (const [side, picker] of pickers) {
    picker.update({
      value: state[side],
      options: (state.catalog?.[side]?.documents ?? []).map((entry) => ({
        value: entry.path,
        label: entry.title || entry.name,
        group: entry.origin_label || entry.origin,
      })),
    });
  }
  findingsLink.href = `/?${pairQuery()}`;
  exportBtn.disabled = !review.run || state.exporting;
  exportBtn.querySelector("span").textContent = state.exporting ? "Exporting…" : "Export PDF";

  const report = review.run?.report;
  outlineItems = report
    ? buildOutlineTree(
        report.input.sections.map((section) => ({ id: section.start, title: section.title, level: section.level })),
      )
    : [];
  outlineNav.update({ items: outlineItems, expandedIds: state.tocExpanded ?? topLevelIds(outlineItems) });
  outlineRail.update({ items: outlineItems });

  doc.setCurrent(state.focused ? state.currentKey : null);
  if (state.screen !== "results" || !report) {
    const title = (path) => entryOf(path)?.title || entryOf(path)?.name || path;
    const screen = document.createElement(state.screen === "loading" ? "p" : "div");
    if (state.screen === "loading") {
      screen.className = "cd-status";
      screen.textContent = "Loading saved results…";
    } else {
      screen.className = "cd-unbundled";
      screen.innerHTML = `<h2 class="cd-unbundled__title"></h2><p class="cd-unbundled__text"></p><div class="cd-unbundled__actions"><a class="demo-btn demo-btn--primary demo-focus">Open the findings page</a></div>`;
      screen.querySelector("h2").textContent = state.error ? "That run could not be loaded" : "We've not run this pair";
      screen.querySelector("p").textContent =
        state.error ??
        `${title(state.reference)} against ${title(state.input)} has no saved run. ` +
          "Run it on the findings page first, then come back to review it.";
      screen.querySelector("a").href = findingsLink.href;
    }
    embed.contentEl.replaceChildren(screen);
    embed.update({ fillHeight: false, panels: [] });
    return;
  }
  if (embed.contentEl.firstChild !== bodyEl) embed.contentEl.replaceChildren(bodyEl);

  const change = current();
  if (state.referenceKey && change) {
    const entry = entryOf(state.reference);
    referenceDoc.update({
      title: entry?.title || entry?.name || "Reference document",
      blocks: buildMarkdownBlocks(
        review.run.reference,
        referenceQuotes(change).map((quote, i) => ({ ...quote.span, kind: change.kind, keys: [`q${i}`] })),
      ),
      activeKey: state.referenceKey,
    });
  } else {
    const parties = (review.reviews?.parties ?? []).map((party) => ({
      value: party.id,
      label: party.name.replace(/^the /, "The "),
    }));
    partyPicker.el.style.display = parties.length < 2 ? "none" : "";
    if (parties.length > 1) partyPicker.update({ value: review.party ?? "", options: parties });
    filterBtn.setAttribute("aria-expanded", String(state.filterOpen));
    filterBtn.classList.toggle("is-filtered", state.kinds.length < KINDS.length || state.showReviewed);
    filterMenu.hidden = !state.filterOpen;
    kindItems.forEach((item, i) => item.setAttribute("aria-checked", String(state.kinds.includes(KINDS[i].id))));
    reviewedItem.setAttribute("aria-checked", String(state.showReviewed));
    historyBtn.setAttribute("aria-pressed", String(state.view === "changes"));

    noteSlot.replaceChildren();
    if (state.reviewsMissing) {
      const { generating } = state;
      const note = document.createElement("div");
      note.className = "rd-note";
      const text = document.createElement("p");
      text.textContent = generating?.error
        ? `Recommendations failed: ${generating.error}`
        : generating
          ? `${generating.message ?? "Working"}${generating.total ? ` ${generating.done}/${generating.total}` : ""}…`
          : "No recommendations for this pair yet; decide by hand.";
      note.append(text);
      if (!generating || generating.error) {
        note.append(
          button({
            className: "demo-btn demo-btn--outline demo-focus",
            html: "Get recommendations",
            title: "Writes summaries, recommendations and rewrites for every finding; takes several minutes",
            onClick: async () => {
              state.generating = { message: "Starting…" };
              render();
              try {
                await startReviews({ reference_path: state.reference, input_path: state.input }, (event) => {
                  if (event.type === "status") state.generating = { message: event.message };
                  else if (event.type === "progress") {
                    state.generating = { ...state.generating, done: event.done, total: event.total };
                  }
                  render();
                });
                state.generating = null;
                await loadReviews();
              } catch (error) {
                state.generating = { error: error.message };
              }
              render();
            },
          }),
        );
      }
      noteSlot.append(note);
    }

    navSlot.replaceChildren();
    if (state.view === "changes") {
      const clear = button({
        className: `rd-clear demo-focus${state.clearArmed ? " is-armed" : ""}`,
        label: state.clearArmed ? "Click again to clear every decision" : "Clear every decision",
        html: `${icon("listX", { size: 15 })}${state.clearArmed ? "Clear all?" : ""}`,
        onClick: () => {
          if (state.clearArmed) {
            state.clearArmed = false;
            return review.clear();
          }
          state.clearArmed = true;
          render();
          setTimeout(() => {
            state.clearArmed = false;
            render();
          }, 4000);
        },
      });
      navSlot.append(backButton(), ...(review.made.length ? [clear] : []));
      listEl.replaceChildren(heading("Change history"), renderChanges(review, (picked) => void select(picked)));
    } else {
      const changes = shown();
      const left = changes.filter((entry) => !review.decided(entry.key)).length;
      leftSlot.textContent = left ? `${left} left` : "All decided";
      const list = visibleList();
      if (state.focused && !list.some((entry) => entry.key === state.currentKey)) {
        state.currentKey = list[0]?.key ?? null;
      }
      const focused = current();
      if (state.focused && focused) {
        if (focusBox?.key !== focused.key) {
          focusBox?.card.destroy();
          const card = createOpenCard(review, focused, async (span) => {
            const i = referenceQuotes(current()).findIndex((quote) => quote.span.start === span.start);
            if (i === -1) return;
            state.referenceKey = `q${i}`;
            render();
            const body = referenceDoc.bodyEl;
            const marked = [...body.querySelectorAll(`.demo-doc__para--bar[data-keys~="q${i}"]`)];
            if (!marked.length) return;
            centerInContainer(marked[0], body);
            await flash(body, marked);
          });
          const el = document.createElement("div");
          el.className = "rd-focus";
          el.tabIndex = -1;
          const nav = document.createElement("div");
          nav.className = "rd-nav";
          const title = heading("");
          el.append(nav, title, card.el);
          focusBox = { key: focused.key, card, el, nav, title };
        } else focusBox.card.refresh();
        const count = document.createElement("span");
        count.className = "rd-pager__count";
        count.textContent = `${list.indexOf(focused) + 1} of ${list.length}`;
        const pager = document.createElement("div");
        pager.className = "rd-pager";
        pager.append(
          button({
            className: "demo-btn demo-btn--ghost demo-focus",
            label: "Previous finding",
            html: icon("chevronLeft"),
            onClick: () => step(-1),
          }),
          count,
          button({
            className: "demo-btn demo-btn--ghost demo-focus",
            label: "Next finding",
            html: icon("chevronRight"),
            onClick: () => step(1),
          }),
        );
        focusBox.nav.replaceChildren(backButton(), pager);
        focusBox.title.textContent = focused.group ?? focused.title;
        if (listEl.firstChild !== focusBox.el || listEl.childNodes.length !== 1) listEl.replaceChildren(focusBox.el);
      } else if (!list.length) {
        const empty = document.createElement("p");
        empty.className = "rd-empty";
        empty.textContent = changes.length ? "Every finding shown is reviewed." : "No findings match the filter.";
        listEl.replaceChildren(leftSlot, empty);
      } else {
        const sections = [];
        list.forEach((entry, i) => {
          if (i === 0 || entry.group !== list[i - 1].group) {
            const section = document.createElement("section");
            section.className = "rd-group";
            if (entry.group) section.append(heading(entry.group, "rd-group__label"));
            sections.push(section);
          }
          sections.at(-1).append(
            renderListCard(review, entry, entry.key === state.currentKey, (picked) => void select(picked, "list")),
          );
        });
        listEl.replaceChildren(leftSlot, ...sections);
      }
    }
    if (!state.focused || state.view === "changes") {
      focusBox?.card.destroy();
      focusBox = null;
    }
  }

  embed.update({
    fillHeight: true,
    panels: [
      { ...PANEL_SHAPES[0], label: "Contents", bodyEl: outlineNav.el, columnBodyEl: outlineRail.el, iconSvg: TOC_ICON },
      {
        ...PANEL_SHAPES[1],
        label: "Findings",
        bodyEl: state.referenceKey && change ? referenceDoc.el : sideEl,
        showLabelWhenWide: false,
      },
    ],
  });
}

const TOUR = {
  id: "conflict-redline",
  steps: [
    { target: '[data-tour="input"] .demo-picker__trigger', title: "Input document", body: "The incoming document to check." },
    {
      target: '[data-tour="reference"] .demo-picker__trigger',
      title: "Reference document",
      body: "The existing standard document to compare against.",
    },
    {
      target: ".rd-party .demo-picker__trigger",
      panel: "findings",
      title: "Party",
      body: "The party you represent.",
    },
    {
      target: ".rd-filter .rd-tool",
      panel: "findings",
      title: "Filter",
      body: "Choose types of findings to show. Findings already reviewed are hidden unless you check 'Reviewed'.",
    },
    {
      target: () => doc.passage(visibleList()[0]?.key) ?? null,
      enter: () => {
        const first = visibleList()[0];
        backToList();
        scrollTo(bodyEl, first && doc.passage(first.key), 64, false);
      },
      await: true,
      title: "Click an input clause",
      body: "Click this clause to see further information.",
    },
    {
      target: ".rd-focus",
      panel: "findings",
      title: "The finding",
      body: "View the results along with the reference text.",
    },
    {
      target: ".rd-focus .rc-view",
      panel: "findings",
      await: true,
      title: "View the reference text",
      body: "Click the eye icon to open the reference document at this clause.",
    },
    {
      target: ".demo-sidebar-doc__back",
      panel: "findings",
      await: true,
      title: "Reference document",
      body: "The matching clause is highlighted. Click 'Finding' to go back.",
    },
    {
      target: ".rd-focus .rc-actions",
      panel: "findings",
      enter: () => {
        state.referenceKey = null;
        render();
      },
      title: "Choose to keep, remove, or rewrite",
      body: "Choosing one of the options turns the passage blue.",
    },
    {
      target: ".rd-history",
      panel: "findings",
      title: "Change history",
      body: "View all the changes you made to the document in chronological order.",
    },
    {
      target: '[data-tour="export"]',
      title: "Export",
      body: "Download a PDF version of the input document with the modifications applied.",
    },
  ],
};

const embed = createEmbed({
  chrome,
  tour: TOUR,
  className: "cd-tokens cdx-tokens",
  headerExtraEl: pickersEl,
  actionsExtraEl: actionsEl,
  expandAt: 1180,
  headerPanels: PANEL_SHAPES,
});

document.getElementById("app").append(embed.el);
embed.el.querySelector(".demo-frame").addEventListener("keydown", onKey);
render();
state.catalog = await getCatalog();
const params = new URLSearchParams(location.search);
const listed = (side, path) => (state.catalog[side]?.documents ?? []).some((entry) => entry.path === path);
const fromUrl = listed("reference", params.get("reference")) && listed("input", params.get("input"));
for (const [side, fallback] of [
  ["reference", "samples/03-common-paper-cloud-service-agreement.md"],
  ["input", "samples/04-mistral-ai-terms-of-use.md"],
]) {
  state[side] = fromUrl ? params.get(side) : listed(side, fallback) ? fallback : state.catalog[side]?.documents?.[0]?.path;
}
await loadPair();
