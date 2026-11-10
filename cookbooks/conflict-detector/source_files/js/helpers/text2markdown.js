import Isaacus from "isaacus";

const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_NO_NL = WS.replace("\\n", "");
const IS_WS = new RegExp(`^[${WS}]$`, "u");
const IS_WS_NO_NL = new RegExp(`^[${WS_NO_NL}]$`, "u");
const LINE_BREAK = /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;

const LIST_PATTERNS = [
  new RegExp(`^[${WS}]{0,3}[-+*][${WS}]+`, "u"),
  new RegExp(`^[${WS}]{0,3}\\p{Nd}+\\.[${WS}]+`, "u"),
  new RegExp(`^[${WS}]{0,3}\\p{Nd}+\\)[${WS}]+`, "u"),
];
const LEADING_FOURS = new RegExp(`^(?:[${WS}]{4})+`, "u");
const LEADING_TWO = new RegExp(`^((?:&emsp;)*)[${WS}]{2}`, "u");
const LEADING_ONE = new RegExp(`^((?:&emsp;|&ensp;)*)[${WS}]`, "u");
const LEADING_WS = new RegExp(`^[${WS}]+`, "u");
const TRAILING_WS = new RegExp(`[${WS}]+$`, "u");

const STATIC_TAGS = {
  junk: ["~~", "~~"],
  quote: ["> ", null],
  ext_ref: ["*", "*"],
  terms: ["*", "*"],
};

function lstrip(s) {
  return s.replace(LEADING_WS, "");
}

function rstrip(s) {
  return s.replace(TRAILING_WS, "");
}

function strip(s) {
  return lstrip(rstrip(s));
}

function splitlines(chars, keepends = false) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < chars.length) {
    if (LINE_BREAK.test(chars[i])) {
      const eol = chars[i] === "\r" && chars[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push(chars.slice(start, keepends ? eol : i));
      start = i = eol;
    } else {
      i += 1;
    }
  }

  if (start < chars.length) {
    lines.push(chars.slice(start));
  }

  return lines;
}

function expandtabs(line) {
  let out = "";
  let column = 0;
  for (const c of line) {
    if (c === "\t") {
      const spaces = 4 - (column % 4);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += c;
      column += 1;
    }
  }

  return out;
}

function annotation(start, end, kind, { forceBlankLine = false, level = null, startId = null } = {}) {
  return { start, end, kind, force_blank_line: forceBlankLine, level, start_id: startId };
}

function key(a) {
  return `${a.start}|${a.end}|${a.kind}|${a.force_blank_line}|${a.level}|${a.start_id}`;
}

function tags(a) {
  switch (a.kind) {
    case "heading":
      return [`\n${"#".repeat(Math.min(6, a.level))} `, "\n"];
    case "xref":
      return ["[", `](#${a.start_id.replaceAll(":", "-")})`];
    case "src_ref":
      return [`<a id="${a.start_id.replaceAll(":", "-")}"></a>`, null];
  }

  return STATIC_TAGS[a.kind];
}

function isListLine(line) {
  return LIST_PATTERNS.some((p) => p.test(line));
}

function annotateEachLine(full, chars, addNewlines = false) {
  const out = [];
  const lines = splitlines(chars.slice(full.start, full.end), true);
  let offset = full.start;
  lines.forEach((line, i) => {
    const addNewline = i === lines.length - 1 && addNewlines;
    const lineEnd = offset + line.length;
    if (strip(line.join(""))) {
      out.push(annotation(offset, lineEnd, full.kind, {
        level: full.level,
        startId: full.start_id,
        forceBlankLine: addNewline,
      }));
    }

    offset = lineEnd;
  });

  return out;
}

function safeAppendTag(md, tag) {
  if (tag === null) {
    return;
  }

  let i = md.length - 1;
  while (i > 0 && !strip(md[i])) {
    i -= 1;
  }

  const textToTag = md[i];
  const stripped = rstrip(textToTag);
  md[i] = textToTag.slice(0, stripped.length) + tag + textToTag.slice(stripped.length);
}

function filterEvents(events) {
  const priority = { junk: 0, ext_ref: 1, terms: 1, xref: 2 };
  let active = [];
  let filteredEvents = [];

  for (const e of events) {
    const ann = e.annotation;
    if (!(ann.kind in priority)) {
      filteredEvents.push(e);
      continue;
    }

    if (e.time === "start") {
      const toRemove = new Set();
      let discard = false;
      for (const a of active) {
        if (ann.start < a.end && ann.end > a.start) {
          if (priority[ann.kind] > priority[a.kind]) {
            toRemove.add(key(a));
          } else {
            discard = true;
            break;
          }
        }
      }

      if (discard) {
        continue;
      }

      if (toRemove.size) {
        active = active.filter((a) => !toRemove.has(key(a)));
        filteredEvents = filteredEvents.filter((ev) => !toRemove.has(key(ev.annotation)));
      }

      active.push(ann);
      filteredEvents.push(e);
    } else {
      const i = active.findIndex((a) => key(a) === key(ann));
      if (i !== -1) {
        active.splice(i, 1);
        filteredEvents.push(e);
      }
    }
  }

  return filteredEvents;
}

function mergeAnnotations(anns, kinds) {
  if (!anns.length) {
    return [];
  }

  function rank(a) {
    return [a.start, a.end, kinds.has(a.kind) ? 1 : 0];
  }
  anns = [...anns].sort((x, y) => compare(rank(x), rank(y)));
  const out = [];
  let skipNext = false;
  let skipped = null;
  for (let i = 0; i < anns.length - 1; i++) {
    const [a1, a2] = [anns[i], anns[i + 1]];
    if (skipNext) {
      skipNext = kinds.has(a2.kind) && skipped !== null && skipped.start === a2.start && skipped.end === a2.end;
      continue;
    }

    skipNext = kinds.has(a1.kind) && kinds.has(a2.kind) && a1.start === a2.start && a1.end === a2.end;
    skipped = a2;
    out.push(a1);
  }

  if (!skipNext) {
    out.push(anns.at(-1));
  }

  return out;
}

function compare(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1;
    }
  }

  return 0;
}

export async function text2markdown(text, {
  linkXrefs = true,
  strikeJunk = true,
  blockQuotes = true,
  escapeLists = true,
  italicizeRefs = true,
  italicizeTerms = true,
  enrichmentModel = "kanon-2-enricher",
  isaacusClient = null,
} = {}) {
  let doc = text;
  if (typeof text === "string") {
    const client = isaacusClient ?? new Isaacus();
    const response = await client.enrichments.create({ model: enrichmentModel, texts: text, overflow_strategy: "auto" });
    doc = response.results[0].document;
  }

  const chars = Array.from(doc.text);
  function decode(span) {
    return chars.slice(span.start, span.end).join("");
  }

  const anns = new Map();
  function add(a) {
    anns.set(key(a), a);
  }
  const headings = doc.headings
    .filter((h) => strip(decode(h)))
    .sort((x, y) => x.start - y.start);
  const segs = [...doc.segments].sort((x, y) => compare([x.span.start, -x.span.end], [y.span.start, -y.span.end]));
  const numSegs = segs.length;

  const disjointSegSpans = [];
  for (const seg of [...segs].reverse()) {
    const last = disjointSegSpans.at(-1);
    const djEnd = last && seg.span.end >= last[0] ? last[0] : seg.span.end;
    disjointSegSpans.push([seg.span.start, djEnd]);
  }

  const title = doc.title;
  if (title && headings.length && headings[0].start <= title.start && title.start < headings[0].end) {
    const h = headings.shift();
    add(annotation(h.start, h.end, "heading", { level: 1 }));
  }

  const idToSeg = new Map([[null, null]]);
  const hasHeading = new Set();

  segs.forEach((seg, idx) => {
    idToSeg.set(seg.id, seg);

    const [spanStart, spanEnd] = disjointSegSpans[numSegs - idx - 1];
    if (spanEnd - spanStart <= 0) {
      return;
    }

    const currLevel = seg.level + 2;
    while (headings.length && headings[0].start < spanStart) {
      const h = headings.shift();
      add(annotation(h.start, h.end, "heading", { level: currLevel }));
    }

    const found = [];
    let lev = currLevel;
    while (headings.length && spanStart <= headings[0].start && headings[0].start < spanEnd) {
      const h = headings.shift();
      found.push([h.start, h.end, lev]);
      lev += 1;
    }

    if (!found.length) {
      return;
    }

    for (const [annStart, annEnd, level] of found) {
      let annLevel = level;
      let curr = idToSeg.get(seg.parent ?? null);
      while (curr !== null && curr !== undefined) {
        if (!hasHeading.has(`${curr.span.start},${curr.span.end}`)) {
          annLevel -= 1;
        }

        curr = idToSeg.get(curr.parent ?? null);
      }

      for (const a of annotateEachLine(annotation(annStart, annEnd, "heading", { level: Math.max(2, annLevel) }), chars)) {
        add(a);
      }
    }

    hasHeading.add(`${seg.span.start},${seg.span.end}`);
  });

  for (const h of headings) {
    add(annotation(h.start, h.end, "heading", { level: 2 }));
  }

  const optionalAnnotators = [
    ["xref", doc.crossreferences, linkXrefs],
    ["junk", doc.junk, strikeJunk],
    ["quote", doc.quotes, blockQuotes],
    ["ext_ref", doc.external_documents, italicizeRefs],
    ["terms", doc.terms, italicizeTerms],
  ];
  for (const [kind, annotators, askedToImplement] of optionalAnnotators) {
    if (!askedToImplement) {
      continue;
    }

    for (const ann of annotators) {
      switch (kind) {
        case "xref": {
          const startId = ann.start;
          for (const a of annotateEachLine(annotation(ann.span.start, ann.span.end, kind, { startId }), chars)) {
            add(a);
          }

          const startSegSpan = idToSeg.get(startId).span;
          add(annotation(startSegSpan.start, startSegSpan.end, "src_ref", { startId }));
          break;
        }
        case "junk":
          for (const a of annotateEachLine(annotation(ann.start, ann.end, kind), chars)) {
            add(a);
          }

          break;
        case "quote": {
          let i = ann.span.end;
          while (i < chars.length && IS_WS_NO_NL.test(chars[i])) {
            i += 1;
          }

          const textFollows = i < chars.length && !IS_WS.test(chars[i]);
          if ((ann.span.start > 0 && chars[ann.span.start - 1] !== "\n") || (ann.span.end < chars.length && textFollows)) {
            continue;
          }

          for (const a of annotateEachLine(annotation(ann.span.start, ann.span.end, kind), chars, true)) {
            add(a);
          }

          break;
        }
        case "ext_ref":
          for (const mention of ann.mentions) {
            for (const a of annotateEachLine(annotation(mention.start, mention.end, kind), chars)) {
              add(a);
            }
          }

          break;
        case "terms":
          for (const a of annotateEachLine(annotation(ann.name.start, ann.name.end, kind), chars)) {
            add(a);
          }

          break;
      }
    }
  }

  const merged = mergeAnnotations([...anns.values()], new Set(["ext_ref", "terms"]));

  let events = [];
  for (const ann of merged) {
    events.push({ position: ann.start, time: "start", annotation: ann });
    if (ann.kind !== "src_ref") {
      events.push({ position: ann.end, time: "end", annotation: ann });
    }
  }

  const kindPriority = { heading: 6, quote: 5, ext_ref: 4, terms: 4, junk: 3, xref: 2, subtitle: 1, src_ref: 0 };
  const zeroLengthAnnotations = new Set(["src_ref"]);

  function eventSortKey(e) {
    const { kind, start, end } = e.annotation;
    if (e.time === "start") {
      return [e.position, 1, zeroLengthAnnotations.has(kind) ? 1 : -(end - start), -kindPriority[kind]];
    }

    return [e.position, 0, zeroLengthAnnotations.has(kind) ? -1 : end - start, kindPriority[kind]];
  }
  events.sort((x, y) => compare(eventSortKey(x), eventSortKey(y)));
  events = filterEvents(events);

  const md = [];
  let currIdx = 0;
  for (const { position, time, annotation: ann } of events) {
    if (currIdx !== position) {
      md.push(chars.slice(currIdx, position).join(""));
    }

    if (time === "start") {
      md.push(tags(ann)[0]);
    } else {
      safeAppendTag(md, tags(ann)[1]);
      if (ann.force_blank_line) {
        md.push("\n\n");
      }
    }

    currIdx = position;
  }

  md.push(chars.slice(currIdx).join(""));
  const raw = md.join("");

  const newlinesAdded = splitlines(Array.from(raw), true)
    .map((line) => line.join(""))
    .map((line) => (line.startsWith("#") ? `${line}\n` : line))
    .join("");

  let prevIsBlank = false;
  const blankRemoved = [];
  for (let line of splitlines(Array.from(newlinesAdded)).map((l) => l.join(""))) {
    if (prevIsBlank && !strip(line)) {
      continue;
    }

    prevIsBlank = !strip(line);

    if (isListLine(line) && lstrip(line) === line && escapeLists) {
      line = `&#8203;${line}`;
    }

    line = expandtabs(line);
    line = line.replace(LEADING_FOURS, (m) => "&emsp;".repeat(Math.floor(m.length / 4)));
    line = line.replace(LEADING_TWO, "$1&ensp;");
    line = line.replace(LEADING_ONE, "$1&nbsp;");

    if (!line.startsWith("> ")) {
      line = line.replace(/\n+$/, "") + "\n";
      prevIsBlank = true;
    }

    blankRemoved.push(strip(line) ? `${line}\n` : line);
  }

  return strip(blankRemoved.join(""));
}
