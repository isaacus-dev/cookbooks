import { sectionAt } from '/demo/markdown.js';
import { buildChanges, cleanDraft, startingText } from '/review/lib/redline.js';

const byPosition = (a, b) => a.at - b.at || Number(a.kind === 'missing') - Number(b.kind === 'missing');

export function createReviewState(notify) {
  const resolutions = new Map();
  const drafts = new Map();
  let run;
  let docs;
  let reviews;
  let changes = [];
  let unfiltered = [];
  let party = null;

  function rebuild() {
    changes = (docs?.changes ?? [])
      .map((change) => {
        const at = change.kind === 'missing' ? finding(change.key)?.insertAt : undefined;
        if (at === undefined) return change;
        return { ...change, at, group: sectionAt(docs.inputBlocks, at - 1) ?? change.group };
      })
      .sort(byPosition);
    unfiltered = changes.filter((change) => !finding(change.key)?.falsePositive);
    notify();
  }

  function set(map, key, value) {
    if (value === undefined) map.delete(key);
    else map.set(key, value);
    notify(key);
  }

  const finding = (key) => reviews?.findings[key];
  const vote = (key) => (party ? finding(key)?.parties[party] : undefined);
  const recommended = (key) => vote(key)?.action;
  const text = (change) =>
    drafts.get(change.key) ?? finding(change.key)?.rewrite ?? startingText(change);

  return {
    setRun(next) {
      run = next;
      resolutions.clear();
      drafts.clear();
      docs = run && buildChanges(run);
      reviews = undefined;
      rebuild();
    },
    setReviews(next) {
      reviews = next;
      if (!reviews?.parties.some((p) => p.id === party)) party = reviews?.parties[0]?.id ?? null;
      rebuild();
    },
    setParty(next) {
      party = next;
      notify();
    },
    get run() {
      return run;
    },
    get reviews() {
      return reviews;
    },
    get party() {
      return party;
    },
    get unfiltered() {
      return unfiltered;
    },
    get made() {
      return changes.filter((change) => resolutions.has(change.key));
    },
    recommended,
    comment: (change) => finding(change.key)?.comment || change.summary,
    quotes(change) {
      const found = [];
      if (change.kind === 'changed' && change.standard?.trim()) {
        found.push({ section: change.title, text: change.standard.trim(), span: change.standardSpan });
      }
      if (change.kind === 'missing' && change.standardSpan && docs) {
        found.push({
          section: sectionAt(docs.referenceBlocks, change.standardSpan.start) ?? change.title,
          text: '',
          span: change.standardSpan,
        });
      }
      for (const span of finding(change.key)?.references ?? []) {
        if (!run || !docs) break;
        const text = run.reference.slice(span.start, span.end).trim();
        if (found.some((quote) => quote.text.includes(text))) continue;
        found.push({ section: sectionAt(docs.referenceBlocks, span.start) ?? undefined, text, span });
      }
      return found;
    },
    decided: (key) => resolutions.get(key),
    action: (key) => resolutions.get(key) ?? recommended(key),
    text,
    edited: (key) => drafts.has(key),
    setText: (key, next) => set(drafts, key, next),
    resetText: (key) => set(drafts, key),
    decide: (key, action) => set(resolutions, key, action),
    undo: (key) => set(resolutions, key),
    clear() {
      resolutions.clear();
      drafts.clear();
      notify();
    },
    cleanMarkdown: () =>
      run
        ? cleanDraft(
            run.input,
            changes,
            new Map(changes.map((change) => [change.key, resolutions.has(change.key) && { action: resolutions.get(change.key), text: text(change) }])),
          )
        : '',
  };
}
