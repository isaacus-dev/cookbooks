import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { normalizeText } from "./normalize.js";
import { sliceText, stripText, textLength, stripTextEnd, stripTextStart } from "./helpers/unicode.js";

export const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.dirname(PROJECT_ROOT);
export const SAMPLES_DIR = path.join(REPO_ROOT, "samples");

export const MARKDOWN_SUFFIXES = [".md", ".markdown"];

export const ENRICHER_MODEL = "kanon-2-enricher";

dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

export function createClause({ doc, seg_id: segId, type, text, start = null, end = null, parent = null,
  category = null, heading = null, order = null, definition = false }) {
  return { doc, seg_id: segId, type, text, start, end, parent, category, heading, order, definition };
}

export async function loadText(docPath) {
  const text = fs.readFileSync(docPath, "utf8").replace(/\r\n?/g, "\n");

  return normalizeText(text, { markdown: MARKDOWN_SUFFIXES.includes(path.extname(docPath).toLowerCase()) });
}

export async function enrichDocument(client, text) {
  return (await client.enrichments.create({
    model: ENRICHER_MODEL,
    texts: text,
    overflow_strategy: "auto",
  })).results[0].document;
}

export function documentSections(document) {
  // The document's titled containers, saved with the index
  const sections = [];

  for (const seg of document.segments) {
    if (seg.kind !== "container" || !seg.title) {
      continue;
    }

    const title = stripText(sliceText(document.text, seg.title.start, seg.title.end));

    if (!title) {
      continue;
    }

    sections.push({
      title, level: seg.level,
      start: seg.span.start, end: seg.span.end,
    });
  }

  return sections;
}

function ownTitle(document, seg) {
  return seg.title ? stripText(sliceText(document.text, seg.title.start, seg.title.end)) : null;
}

const MARKDOWN_HEADING = /^#+[\t-\r\x1c-\x20\x85\p{Z}]+(.+)$/gmu;
const HEADING_NUMBER = /^\p{Nd}+(?:\\?\.\p{Nd}+)*\\?\.?[\t-\r\x1c-\x20\x85\p{Z}]+/u;
const DEFINITION_LEAD = /^(?:[^\p{L}\p{N}]|[\p{Nd}_])*(?:(?:the|an?)(?![\p{L}\p{N}_])[^\p{L}\p{N}]*)?/iu;

function markdownHeadings(text) {
  const found = [];

  for (const match of text.matchAll(MARKDOWN_HEADING)) {
    const title = stripText(match[1].replaceAll("*", "").replace(HEADING_NUMBER, ""));

    if (title) {
      found.push([textLength(text.slice(0, match.index)), title]);
    }
  }

  return found;
}

function resolveHeadings(document) {
  const markdown = markdownHeadings(document.text);
  const segments = new Map(document.segments.map((seg) => [seg.id, seg]));
  const headings = {};

  for (const seg of document.segments) {
    let [parentId, heading] = [seg.parent, null];

    while (parentId !== null && segments.has(parentId)) {
      heading = ownTitle(document, segments.get(parentId));

      if (heading) {
        break;
      }

      parentId = segments.get(parentId).parent;
    }

    // Title of the closest parent section that has one, else its own title, else the nearest markdown heading above
    headings[seg.id] = heading || ownTitle(document, seg)
      || (markdown.findLast(([start]) => start <= seg.span.start)?.[1] ?? null);
  }

  return headings;
}

function opening(text) {
  return text.slice(DEFINITION_LEAD.exec(text)[0].length);
}

function definesTerm(document, { start, end }) {
  const clauseOpening = opening(sliceText(document.text, start, end));

  // A definition opens with a term the enricher found, and that term is defined inside this clause
  return document.terms.some((term) => (
    clauseOpening.startsWith(opening(sliceText(document.text, term.name.start, term.name.end)))
    && [term.name.start, term.meaning.start].some((pos) => start <= pos && pos < end)
  ));
}

function hasBody(document, seg, { start, end }) {
  // Spans that only label the segment: its type name ("Section"), code ("4.2") and title
  const labels = [seg.type_name, seg.code, seg.title].filter(Boolean).map((span) => [span.start, span.end]);

  // Markdown heading lines count as labels too
  let pos = start;

  for (const line of sliceText(document.text, start, end).split("\n")) {
    if (stripTextStart(line).startsWith("#")) {
      labels.push([pos, pos + textLength(line)]);
    }

    pos += textLength(line) + 1;
  }

  // It has a body if any letter or digit sits outside every label
  for (const [offset, char] of Array.from(sliceText(document.text, start, end)).entries()) {
    const n = start + offset;

    if (/[\p{L}\p{N}]/u.test(char) && !labels.some(([a, b]) => a <= n && n < b)) {
      return true;
    }
  }

  return false;
}

export function extractClauses(docName, document) {
  const headings = resolveHeadings(document);
  const spans = new Map(document.segments.map((seg) => [seg.id, seg.span]));
  const clauses = [];

  for (const seg of document.segments) {
    const pieces = [];
    let cut = seg.span.start;

    // Cut the segment around its children's spans; each word belongs to one clause
    for (const child of seg.children.map((c) => spans.get(c)).sort((x, y) => x.start - y.start)) {
      pieces.push([cut, child.start]);
      cut = Math.max(cut, child.end);
    }

    pieces.push([cut, seg.span.end]);

    for (const [n, [start, end]] of pieces.entries()) {
      const raw = sliceText(document.text, start, end);
      const clauseText = stripText(raw);

      if (!hasBody(document, seg, { start, end })) {
        continue;
      }

      // Offsets of the text once leading and trailing whitespace is trimmed
      const clauseStart = start + textLength(raw) - textLength(stripTextStart(raw));
      const clauseEnd = start + textLength(stripTextEnd(raw));
      clauses.push(createClause({
        doc: docName, seg_id: n === 0 ? seg.id : `${seg.id}.${n}`, type: seg.type,
        text: clauseText, start: clauseStart, end: clauseEnd, parent: seg.parent,
        category: seg.category, heading: headings[seg.id],
        definition: definesTerm(document, { start: clauseStart, end: clauseEnd }),
      }));
    }
  }

  clauses.sort((x, y) => x.start - y.start);

  for (const [order, clause] of clauses.entries()) {
    clause.order = order;
  }

  return clauses;
}

export const EMBEDDER_MODEL = "kanon-2-embedder";
export const EMBED_BATCH_SIZE = 96;

export function unitNormalize(rows) {
  const vectors = { data: Float32Array.from(rows.flat()), shape: rows.length ? [rows.length, rows[0].length] : [0, 0] };

  if (vectors.data.length === 0) {
    return vectors;
  }

  const [count, dims] = vectors.shape;

  for (let r = 0; r < count; r++) {
    const row = vectors.data.subarray(r * dims, (r + 1) * dims);

    // Divide each vector by its length; an all-zero vector stays zero rather than dividing by zero
    const norm = Math.sqrt(row.reduce((sum, x) => sum + x * x, 0)) || 1;

    for (let c = 0; c < dims; c++) {
      row[c] /= norm;
    }
  }

  return vectors;
}

export async function embedPropositions(client, texts, { task = "retrieval/document" } = {}) {
  const rows = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const resp = await client.embeddings.create({
      model: EMBEDDER_MODEL,
      texts: texts.slice(i, i + EMBED_BATCH_SIZE),
      task,
    });
    rows.push(...resp.embeddings.map((e) => e.embedding));
  }

  return unitNormalize(rows);
}

export const RESULTS_DIR = path.join(PROJECT_ROOT, "results");
export const DOC_CACHE_DIR = path.join(RESULTS_DIR, "cache");
export const DOCUMENTS_DIR = path.join(RESULTS_DIR, "documents");

export const DOCUMENT_SCHEMA = "conflict-document/1";

export const PIPELINE_VERSION = 19;

export function createDocumentIndex({ propositions, embeddings, manifest = null, text = null, sections = null }) {
  // One document's clauses (called propositions here), their embeddings and its cleaned text
  return { propositions, embeddings, manifest, text, sections };
}

function npLoad(file) {
  const buf = fs.readFileSync(file);
  const end = 10 + buf.readUInt16LE(8);
  const shape = /'shape': \(([^)]*)\)/.exec(buf.toString("latin1", 10, end))[1];

  return {
    data: new Float32Array(buf.buffer.slice(buf.byteOffset + end, buf.byteOffset + buf.length)),
    shape: shape.split(",").filter((n) => n.trim()).map(Number),
  };
}

function npSave(file, { data, shape }) {
  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}), }`;
  const header = `${dict.padEnd(dict.length + 63 - ((10 + dict.length) % 64))}\n`;
  const size = Buffer.alloc(2);
  size.writeUInt16LE(header.length);
  fs.writeFileSync(file, Buffer.concat([Buffer.from("\x93NUMPY\x01\x00", "latin1"), size,
    Buffer.from(header, "latin1"), Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
}

export function readIndex(indexDir) {
  let rows;
  let matrix;
  let manifest;
  let text;
  let sections;

  try {
    rows = JSON.parse(fs.readFileSync(path.join(indexDir, "propositions.json"), "utf8"));
    matrix = npLoad(path.join(indexDir, "embeddings.npy"));
    manifest = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
    text = fs.readFileSync(path.join(indexDir, "text.txt"), "utf8");
    sections = JSON.parse(fs.readFileSync(path.join(indexDir, "sections.json"), "utf8"));
  } catch {
    return null;
  }

  if (matrix.shape.length !== 2 || matrix.shape[0] !== rows.length) {
    return null;
  }

  return createDocumentIndex({
    propositions: rows.map((row) => createClause(row)),
    embeddings: matrix,
    manifest,
    text,
    sections,
  });
}

export function writeIndex(index, indexDir) {
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(
    path.join(indexDir, "manifest.json"), JSON.stringify(index.manifest, null, 2), "utf8",
  );
  fs.writeFileSync(
    path.join(indexDir, "propositions.json"),
    JSON.stringify(index.propositions, null, 2),
    "utf8",
  );
  npSave(path.join(indexDir, "embeddings.npy"), index.embeddings);
  fs.writeFileSync(path.join(indexDir, "text.txt"), index.text, "utf8");
  fs.writeFileSync(
    path.join(indexDir, "sections.json"), JSON.stringify(index.sections || [], null, 2), "utf8",
  );

  return indexDir;
}

export async function documentIdentity(docPath, index, { text = null } = {}) {
  if (text === null) {
    text = index.text !== null ? index.text : await loadText(docPath);
  }

  const rel = path.relative(fs.realpathSync(REPO_ROOT), fs.realpathSync(docPath)).split(path.sep).join("/");

  return {
    source: rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) ? String(docPath) : rel,
    source_sha256: crypto.createHash("sha256").update(fs.readFileSync(docPath)).digest("hex"),
    text_sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    sections: index.sections || [],
  };
}

export async function documentArtifact(docPath, index) {
  let text = await loadText(docPath);

  if (!(index.text === null || index.text === text)) {
    throw new Error(`${path.basename(docPath)}: clear results/cache`);
  }

  text = index.text !== null ? index.text : text;

  return { schema: DOCUMENT_SCHEMA, ...(await documentIdentity(docPath, index, { text })), text };
}

export async function writeDocumentArtifact(docPath, index, { documentsDir = DOCUMENTS_DIR } = {}) {
  // The report only stores offsets, so the demo reads each document's text from here
  const payload = await documentArtifact(docPath, index);
  const dest = path.join(documentsDir, `${payload.source_sha256}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n", "utf8");

  return dest;
}

export function documentFingerprint(normalizedText) {
  // Any change to the text, the pipeline version or a model re-indexes; delete results/cache/ to force it
  const stamp = `${PIPELINE_VERSION}|${ENRICHER_MODEL}|${EMBEDDER_MODEL}|${normalizedText}`;

  return crypto.createHash("sha256").update(stamp, "utf8").digest("hex").slice(0, 16);
}

function documentManifest(docName, docPath, entry) {
  return { doc_name: docName, source_path: String(docPath), files: { [docName]: entry } };
}

export async function indexDocument(client, docPath, { useCache = true } = {}) {
  const text = await loadText(docPath);
  const cacheDir = path.join(DOC_CACHE_DIR, documentFingerprint(text));

  if (useCache) {
    const cached = rekey(readIndex(cacheDir), path.basename(docPath), docPath);

    if (cached !== null) {
      return cached;
    }
  }

  const document = await enrichDocument(client, text);
  const propositions = extractClauses(path.basename(docPath), document);

  const index = createDocumentIndex({
    propositions,
    embeddings: await embedPropositions(client, propositions.map((p) => p.text)),
    text: document.text,
    sections: documentSections(document),
    manifest: documentManifest(path.basename(docPath), docPath, {
      proposition_count: propositions.length, clause_count: propositions.length }),
  });
  writeIndex(index, cacheDir);

  return index;
}

export function rekey(index, docName, docPath) {
  if (index === null || index.text === null) {
    return null;
  }

  // A cached index may have been saved under another file name
  for (const clause of index.propositions) {
    clause.doc = docName;
  }

  const entry = Object.values((index.manifest || {}).files ?? {})[0] ?? {};
  index.manifest = documentManifest(docName, docPath, entry);

  return index;
}
