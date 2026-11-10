import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { parseArgs as parseNodeArgs } from "node:util";

import Isaacus from "isaacus";

import {
  loadText,
  RESULTS_DIR,
  SAMPLES_DIR,
  PROJECT_ROOT,
  DOCUMENTS_DIR,
  indexDocument,
  EMBEDDER_MODEL,
  ENRICHER_MODEL,
  documentIdentity,
  PIPELINE_VERSION,
  writeDocumentArtifact,
} from "./document_index.js";
import { sliceText, splitText } from "./helpers/unicode.js";

export const CLASSIFIER_MODEL = "kanon-universal-classifier";

export const SHORTLIST_MIN_RELEVANCE = 0.5;
export const SHORTLIST_TOP_K = 3;

export const STRUCTURAL_CATEGORIES = ["front_matter", "back_matter", "annotation"];

export const FILTER_QUERY = "{This is a footnote, citation, editorial note, heading or signature, "
  + "not a contractual provision.}";
export const FILTER_THRESHOLD = 0.5;

export function pairMatrix(input, reference) {
  if (input.embeddings.data.length === 0 || reference.embeddings.data.length === 0) {
    return input.propositions.map(() => new Array(reference.propositions.length).fill(0));
  }

  const [a, b, dims] = [input.embeddings.data, reference.embeddings.data, input.embeddings.shape[1]];

  return input.propositions.map((_, i) => reference.propositions.map((_, j) => {
    let dot = 0;

    for (let k = 0; k < dims; k++) {
      dot += a[i * dims + k] * b[j * dims + k];
    }

    return Math.fround(dot);
  }));
}

export async function nonOperative(client, index) {
  const scores = await classify(client, FILTER_QUERY, index.propositions.map((c) => flatten(c.text)), { isIql: true });

  return index.propositions.map((c, n) => (
    STRUCTURAL_CATEGORIES.includes(c.category) || (!c.definition && scores[n] >= FILTER_THRESHOLD)
  ));
}

export function maskNonOperative(sim, inc, ref) {
  // A filtered clause scores -1 with everything, so it can't be shortlisted
  return sim.map((row, i) => row.map((value, j) => (inc[i] || ref[j] ? -1.0 : value)));
}

export function shortlistPairs(sim, { minRelevance, topK }) {
  if (sim.flat().length === 0) {
    return new Map();
  }

  function rank(values) {
    const ranks = new Array(values.length);
    values.map((_, n) => n).sort((x, y) => values[y] - values[x] || x - y).forEach((n, r) => {
      ranks[n] = r;
    });

    return ranks;
  }

  // Rank of each pair among its input clause's matches, and among its reference clause's (0 = closest)
  const rowRank = sim.map(rank);
  const colRank = sim[0].map((_, j) => rank(sim.map((row) => row[j])));

  const shortlist = new Map();
  sim.forEach((row, i) => row.forEach((value, j) => {
    // Keep a pair that's similar enough and in the top k for either clause
    if (value >= minRelevance && (rowRank[i][j] < topK || colRank[j][i] < topK)) {
      if (!shortlist.has(i)) {
        shortlist.set(i, []);
      }

      shortlist.get(i).push([j, value]);
    }
  }));

  for (const row of shortlist.values()) {
    row.sort((x, y) => y[1] - x[1]);
  }

  return shortlist;
}

function flatten(text) {
  return splitText(text).join(" ");
}

function span(clause) {
  if (clause.start === null || clause.end === null) {
    return null;
  }

  return { start: clause.start, end: clause.end };
}

function clauseRef(clause) {
  return { seg_id: clause.seg_id, text: flatten(clause.text), span: span(clause) };
}

export const CLASSIFY_MAX_PARALLEL_REQUESTS = 6;
export const CLASSIFY_BATCH_SIZE = 50;

export async function mapPool(items, concurrency, worker) {
  // Runs worker over items, at most concurrency at a time: the stand-in for Python's ThreadPoolExecutor
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));

  return results;
}

async function batched(score, texts) {
  const batches = [];

  for (let n = 0; n < texts.length; n += CLASSIFY_BATCH_SIZE) {
    batches.push(texts.slice(n, n + CLASSIFY_BATCH_SIZE));
  }

  return (await mapPool(batches, CLASSIFY_MAX_PARALLEL_REQUESTS, score)).flat();
}

async function classifyBatch(client, batch, { query, isIql }) {
  const resp = await client.classifications.universal.create({
    model: CLASSIFIER_MODEL, query, texts: batch, is_iql: isIql, scoring_method: "auto",
  });

  return [...resp.classifications].sort((a, b) => a.index - b.index).map((c) => c.score);
}

async function classify(client, query, texts, { isIql = false } = {}) {
  return batched((batch) => classifyBatch(client, batch, { query, isIql }), texts);
}

export const RERANKER_MODEL = "kanon-2-reranker";

export const EMPTY_QUERY = "routine boilerplate, a recital, a preamble, a heading, a signature block, "
  + "an address or a definition";
export const CARE_STATEMENT = "A party would not care whether this clause or the following clause applied: {clause}";
export const AGREE_QUERY = "A lawyer would compare this clause with the following clause: {clause}";
export const MONEY_STATEMENT = "This states an amount of money, a percentage or a cap.";
export const CLASSIFY_QUERY_MAX_CHARS = 2000;
export const MATCH_TEMPERATURE = 0.06;
export const SAME_SLOPE = 2.049;
export const SAME_BIAS = 3.058;

export const EMPTY_WEIGHT = -4.0;
export const CARE_WEIGHT = -1.0;
export const AGREE_WEIGHT = -1.0;
export const MONEY_WEIGHT = 1.0;
export const DIFFERS_SLOPE = 0.526;
export const DIFFERS_BIAS = -12.312;
export const CONFLICT_SAME_SLOPE = 0.576;

export const CONFLICT_DIFFERS_SLOPE = 0.707;
export const CONFLICT_BIAS = 1.663;

async function rerankBatch(client, batch, { query }) {
  const resp = await client.rerankings.create({ model: RERANKER_MODEL, query, texts: batch });

  return [...resp.results].sort((a, b) => a.index - b.index).map((r) => r.score);
}

async function rerank(client, query, texts) {
  return batched((batch) => rerankBatch(client, batch, { query }), texts);
}

function logit(p) {
  p = Math.min(Math.max(p, 1e-6), 1 - 1e-6);

  return Math.log(p / (1 - p));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function logSigmoid(x) {
  // log(sigmoid(x)), without rounding tiny probabilities to zero
  return -(Math.max(0, -x) + Math.log1p(Math.exp(-Math.abs(x))));
}

function mean(scores, a, b) {
  return (scores.get(a) + scores.get(b)) / 2;
}

async function scoreQuery(b, { texts, score, template, maxChars }) {
  // Ask the model about clause b once, against every clause it's paired with
  const scores = await score(template.replace("{clause}", () => sliceText(b, 0, maxChars)), texts);

  return texts.map((a, n) => [JSON.stringify([a, b]), scores[n]]);
}

async function pairwise(score, template, pairs, { maxChars } = {}) {
  const byQuery = new Map();

  // Group pairs by their second clause, so each clause goes to the model once
  for (const [a, b] of new Map(pairs.map((pair) => [JSON.stringify(pair), pair])).values()) {
    if (!byQuery.has(b)) {
      byQuery.set(b, []);
    }

    byQuery.get(b).push(a);
  }

  const results = await mapPool([...byQuery], CLASSIFY_MAX_PARALLEL_REQUESTS,
    ([b, texts]) => scoreQuery(b, { texts, score, template, maxChars }));

  return new Map(results.flat());
}

export function createPairScore({ relevance, match, empty, care, agree, money }) {
  return {
    relevance, match, empty, care, agree, money,
    get sameMatter() {
      return sigmoid(SAME_SLOPE * this.match + SAME_BIAS);
    },
    get materiality() {
      return EMPTY_WEIGHT * logit(this.empty) + CARE_WEIGHT * logit(this.care)
        + AGREE_WEIGHT * logit(this.agree) + MONEY_WEIGHT * logit(this.money);
    },
    get differs() {
      return sigmoid(DIFFERS_SLOPE * this.materiality + DIFFERS_BIAS);
    },
    get conflict() {
      return sigmoid(CONFLICT_SAME_SLOPE * logSigmoid(SAME_SLOPE * this.match + SAME_BIAS)
        + CONFLICT_DIFFERS_SLOPE * logSigmoid(DIFFERS_SLOPE * this.materiality + DIFFERS_BIAS)
        + CONFLICT_BIAS);
    },
  };
}

export function matchMatrix(sim) {
  const logits = sim.map((row) => row.map((s) => s / MATCH_TEMPERATURE));

  function logSumExp(values) {
    const max = Math.max(...values);

    return max + Math.log(values.reduce((sum, v) => sum + Math.exp(v - max), 0));
  }

  const rows = logits.map(logSumExp);
  const cols = (logits[0] ?? []).map((_, j) => logSumExp(logits.map((row) => row[j])));

  return logits.map((row, i) => row.map((l, j) => ((l - rows[i]) + (l - cols[j])) / 2));
}

export async function scorePairs(client, input, reference, { shortlist }) {
  const match = matchMatrix(pairMatrix(input, reference));
  const texts = new Map([...shortlist].flatMap(([i, row]) => row.map(([j]) => [
    `${i}:${j}`, [flatten(input.propositions[i].text), flatten(reference.propositions[j].text)],
  ])));
  const unique = [...new Set([...texts.values()].flat())];
  const bothWays = [...texts.values()].flatMap(([a, b]) => [[a, b], [b, a]]);
  const empty = new Map((await rerank(client, EMPTY_QUERY, unique)).map((score, n) => [unique[n], score]));
  const money = new Map((await classify(client, MONEY_STATEMENT, unique)).map((score, n) => [unique[n], score]));
  const care = await pairwise((query, texts) => classify(client, query, texts), CARE_STATEMENT, bothWays, {
    maxChars: CLASSIFY_QUERY_MAX_CHARS,
  });
  const agree = await pairwise((query, texts) => rerank(client, query, texts), AGREE_QUERY, bothWays);

  return new Map([...shortlist].flatMap(([i, candidates]) => candidates.map(([j, relevance]) => {
    const [a, b] = texts.get(`${i}:${j}`);

    return [`${i}:${j}`, createPairScore({
      relevance, match: match[i][j],
      empty: mean(empty, a, b), money: mean(money, a, b),
      care: mean(care, JSON.stringify([a, b]), JSON.stringify([b, a])),
      agree: mean(agree, JSON.stringify([a, b]), JSON.stringify([b, a])),
    })];
  })));
}

export const SAME_THRESHOLD = 0.3;

export const CONFLICT_THRESHOLD = 0.728;

function status(pairs, { deviating }) {
  const best = pairs.reduce((top, e) => (top === null || e[1].relevance > top[1].relevance ? e : top), null);

  return {
    status: deviating ? "deviation" : pairs.length ? "covered" : "gap",
    best_relevance: best ? best[1].relevance : null,
    nearest_index: best ? best[0] : null,
  };
}

function sideStatus(index, pairs, deviating) {
  return Object.fromEntries(index.propositions.map((_, n) => [
    n, status(pairs.get(n) ?? [], { deviating: deviating.has(n) }),
  ]));
}

export function partition(input, reference, scored) {
  const closest = [new Map(), new Map()];

  // For each clause on each side, keep its best match that's about the same matter
  for (const [key, sc] of scored) {
    const pair = key.split(":").map(Number);

    for (const [side, best] of closest.entries()) {
      if (sc.sameMatter >= SAME_THRESHOLD && (!best.has(pair[side]) || sc.match > best.get(pair[side])[1].match)) {
        best.set(pair[side], [key, sc]);
      }
    }
  }

  // Both sides' picks together; a pair both clauses picked appears once
  const selected = new Map(closest.flatMap((best) => [...best.values()]));

  // A picked pair is a deviation when its P(conflict) clears the threshold
  const deviatingPairs = [...selected].filter(([, sc]) => sc.conflict >= CONFLICT_THRESHOLD)
    .map(([key, sc]) => [...key.split(":").map(Number), sc]);

  const incPairs = new Map();
  const refPairs = new Map();

  for (const [key, score] of scored) {
    const [i, j] = key.split(":").map(Number);

    if (score.sameMatter >= SAME_THRESHOLD) {
      if (!incPairs.has(i)) {
        incPairs.set(i, []);
      }

      if (!refPairs.has(j)) {
        refPairs.set(j, []);
      }

      incPairs.get(i).push([j, score]);
      refPairs.get(j).push([i, score]);
    }
  }

  return [deviatingPairs,
    sideStatus(input, incPairs, new Set(deviatingPairs.map(([i]) => i))),
    sideStatus(reference, refPairs, new Set(deviatingPairs.map(([, j]) => j)))];
}

function clauseRow(clause) {
  return {
    id: null,
    seg_id: clause.seg_id,
    heading: clause.heading,
    text: flatten(clause.text),
    span: span(clause),
    order: clause.order,
    category: clause.category,
  };
}

function numbered(rows, sortKey) {
  // Number rows in document order, so the report reads top to bottom like the documents
  rows.sort(sortKey);
  rows.forEach((row, n) => {
    row.id = n + 1;
  });

  return rows;
}

export function rollUpDeviations(deviatingPairs, input, reference) {
  const byInput = new Map();

  for (const [i, j, score] of deviatingPairs) {
    if (!byInput.has(i)) {
      byInput.set(i, []);
    }

    byInput.get(i).push([j, score]);
  }

  const rows = [];

  for (const [i, pairs] of byInput) {
    pairs.sort((a, b) => (reference.propositions[a[0]].order || 0) - (reference.propositions[b[0]].order || 0));
    rows.push({
      ...clauseRow(input.propositions[i]),
      relevance: pairs[0][1].relevance,
      match_count: pairs.length,
      matches: pairs.map(([j, score]) => ({
        input: clauseRef(input.propositions[i]),
        reference: {
          ...clauseRef(reference.propositions[j]),
          clause_text: flatten(reference.propositions[j].text),
        },
        relevance: score.relevance,
      })),
    });
  }

  return numbered(rows, (a, b) => (a.order || 0) - (b.order || 0));
}

export function rollUpGaps(index, status, { other, filtered }) {
  const rows = [];

  for (const [i, clause] of index.propositions.entries()) {
    const info = status[i];

    if (filtered[i] || info.status !== "gap" || clause.definition) {
      continue;
    }

    const near = info.nearest_index;
    rows.push({
      ...clauseRow(clause),
      propositions: { total: 1, matched_count: 0, uncovered_count: 1 },
      gap_score: 1.0 - (info.best_relevance || 0.0),
      uncovered_propositions: [{
        ...clauseRef(clause),
        status: info.status,
        best_relevance: info.best_relevance,
        nearest: near !== null ? clauseRef(other.propositions[near]) : null,
      }],
    });
  }

  return numbered(rows, (a, b) => (a.order || 0) - (b.order || 0));
}

export const REPORTS_DIR = path.join(RESULTS_DIR, "reports");

export const SCHEMA = "doc-compare/2";

function coverageCounts(status, filtered) {
  const counts = {
    total: Object.keys(status).length, covered: 0, deviation: 0, gap: 0,
    filtered: filtered.filter(Boolean).length,
  };

  for (const [n, row] of Object.entries(status)) {
    if (!filtered[n]) {
      counts[row.status] += 1;
    }
  }

  return counts;
}

async function documentSummary(index, docPath) {
  return {
    name: path.basename(docPath),
    ...(await documentIdentity(docPath, index)),
    propositions: index.propositions.length,
  };
}

export function scoredPairsRows(input, reference, scored, { deviating }) {
  const rows = [];

  for (const [key, score] of scored) {
    const [i, j] = key.split(":").map(Number);
    const [inc, ref] = [input.propositions[i], reference.propositions[j]];
    rows.push({
      input_seg: inc.seg_id, input: flatten(inc.text),
      reference_seg: ref.seg_id, reference: flatten(ref.text),
      relevance: score.relevance, same_matter: score.sameMatter, differs: score.differs,
      conflict: score.conflict,
      deviating: deviating.has(key),
    });
  }

  rows.sort((a, b) => b.relevance - a.relevance);

  return rows;
}

export async function buildReport({
  reference, input, referencePath, inputPath,
  deviationRows, gapsReference, gapsInput,
  inputStatus, referenceStatus, inputFiltered, referenceFiltered, pairs,
}) {
  return {
    schema: SCHEMA,
    reference: await documentSummary(reference, referencePath),
    input: await documentSummary(input, inputPath),
    summary: {
      deviation_rows: deviationRows.length,
      deviations: deviationRows.reduce((sum, row) => sum + row.match_count, 0),
      shortlisted_pairs: pairs.length,
      gaps_reference: gapsReference.length,
      gaps_input: gapsInput.length,
      reference_coverage: coverageCounts(referenceStatus, referenceFiltered),
      input_coverage: coverageCounts(inputStatus, inputFiltered),
    },
    summaries: null,
    recommendations: null,
    deviations: deviationRows,
    gaps_reference: gapsReference,
    gaps_input: gapsInput,
    pairs,
  };
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
    || "document";
}

export function pairSlug(referencePath, inputPath) {
  return `${slug(path.parse(referencePath).name)}__${slug(path.parse(inputPath).name)}`;
}

export function analysisParams() {
  return {
    schema: SCHEMA,
    pipeline_version: PIPELINE_VERSION,
    enricher_model: ENRICHER_MODEL,
    embedder_model: EMBEDDER_MODEL,
    classifier_model: CLASSIFIER_MODEL,
    shortlist_min_relevance: SHORTLIST_MIN_RELEVANCE,
    shortlist_top_k: SHORTLIST_TOP_K,
    filter_query: FILTER_QUERY,
    filter_threshold: FILTER_THRESHOLD,
    reranker_model: RERANKER_MODEL,
    empty_query: EMPTY_QUERY,
    care_statement: CARE_STATEMENT,
    agree_query: AGREE_QUERY,
    money_statement: MONEY_STATEMENT,
    classify_query_max_chars: CLASSIFY_QUERY_MAX_CHARS,
    match_temperature: MATCH_TEMPERATURE,
    same_slope: SAME_SLOPE,
    same_bias: SAME_BIAS,
    same_threshold: SAME_THRESHOLD,
    materiality_weights: [EMPTY_WEIGHT, CARE_WEIGHT, AGREE_WEIGHT, MONEY_WEIGHT],
    differs_slope: DIFFERS_SLOPE,
    differs_bias: DIFFERS_BIAS,
    conflict_slopes: [CONFLICT_SAME_SLOPE, CONFLICT_DIFFERS_SLOPE],
    conflict_bias: CONFLICT_BIAS,
    conflict_threshold: CONFLICT_THRESHOLD,
    structural_categories: [...STRUCTURAL_CATEGORIES],
  };
}

export function comparisonDirFor(referencePath, inputPath, { runsDir = REPORTS_DIR } = {}) {
  return path.join(runsDir, pairSlug(referencePath, inputPath));
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function savedReportIfCurrent(comparisonDir, referencePath, inputPath) {
  const report = readJson(path.join(comparisonDir, "report.json"));
  const saved = readJson(path.join(comparisonDir, "params.json"));

  if (report === null || saved === null) {
    return null;
  }

  const current = analysisParams();

  if (JSON.stringify(Object.fromEntries(Object.keys(current).map((k) => [k, saved[k] ?? null])))
    !== JSON.stringify(current)) {
    return null;
  }

  for (const [side, docPath] of [["reference", referencePath], ["input", inputPath]]) {
    const text = await loadText(docPath);

    if ((report[side] ?? {}).text_sha256 !== crypto.createHash("sha256").update(text, "utf8").digest("hex")) {
      return null;
    }
  }

  return report;
}

export async function writeAnalysisRun(report, {
  reference, input, referencePath, inputPath, runDir,
  label = null, documentsDir = DOCUMENTS_DIR,
}) {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });

  const params = {
    ...analysisParams(),
    slug: path.basename(runDir),
    label,
    created_at: new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z"),
  };

  for (const [name, payload] of [
    ["report", Object.fromEntries(Object.entries(report).filter(([k]) => k !== "pairs"))],
    ["pairs", report.pairs || []],
    ["params", params],
  ]) {
    fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(payload, null, 2), "utf8");
  }

  await writeDocumentArtifact(referencePath, reference, { documentsDir });
  await writeDocumentArtifact(inputPath, input, { documentsDir });

  return runDir;
}

export async function runComparison(client, referencePath, inputPath, { useCache = true, label = null } = {}) {
  const dest = comparisonDirFor(referencePath, inputPath);
  const saved = useCache ? await savedReportIfCurrent(dest, referencePath, inputPath) : null;

  if (saved !== null) {
    return saved;
  }

  console.log("STAGE: Reading documents");
  const reference = await indexDocument(client, referencePath, { useCache });
  const input = await indexDocument(client, inputPath, { useCache });

  console.log("STAGE: Filtering");
  const [inputFiltered, referenceFiltered] = [await nonOperative(client, input), await nonOperative(client, reference)];

  console.log("STAGE: Matching");
  const shortlist = shortlistPairs(
    maskNonOperative(pairMatrix(input, reference), inputFiltered, referenceFiltered),
    { minRelevance: SHORTLIST_MIN_RELEVANCE, topK: SHORTLIST_TOP_K },
  );

  console.log("STAGE: Classifying");
  const scored = await scorePairs(client, input, reference, { shortlist });

  console.log("STAGE: Comparing");
  const [deviatingPairs, inputStatus, referenceStatus] = partition(input, reference, scored);

  const deviationRows = rollUpDeviations(deviatingPairs, input, reference);
  const gapsReference = rollUpGaps(reference, referenceStatus, { other: input, filtered: referenceFiltered });
  const gapsInput = rollUpGaps(input, inputStatus, { other: reference, filtered: inputFiltered });

  console.log("STAGE: Assembling report");
  const report = await buildReport({
    reference, input, referencePath, inputPath,
    deviationRows, gapsReference, gapsInput,
    inputStatus, referenceStatus, inputFiltered, referenceFiltered,
    pairs: scoredPairsRows(
      input, reference, scored, { deviating: new Set(deviatingPairs.map(([i, j]) => `${i}:${j}`)) },
    ),
  });

  console.log("STAGE: Saving results");
  await writeAnalysisRun(report, {
    reference, input, referencePath, inputPath, runDir: dest, label,
  });

  return report;
}

function resolveDocArg(raw) {
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }

  const roots = [process.cwd(), PROJECT_ROOT, SAMPLES_DIR];

  return path.resolve(roots.map((r) => path.join(r, raw))
    .find((option) => fs.statSync(option, { throwIfNoEntry: false })?.isFile()) ?? path.join(PROJECT_ROOT, raw));
}

function parseArgs() {
  const { values } = parseNodeArgs({ options: {
    reference: { type: "string" },
    input: { type: "string" },
    label: { type: "string" },
    "no-cache": { type: "boolean", default: false },
  } });
  const missing = ["--reference", "--input"].filter((flag) => values[flag.slice(2)] === undefined);

  if (missing.length) {
    console.error(`document_analysis.js: error: the following arguments are required: ${missing.join(", ")}`);
    process.exit(2);
  }

  return { ...values, label: values.label ?? null, noCache: values["no-cache"] };
}

export function documentPathsFromArgs(args) {
  const paths = [args.reference, args.input].map(resolveDocArg);

  for (const p of paths) {
    if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
      console.error(`Document not found: ${p}`);
      process.exit(1);
    }
  }

  return paths;
}

async function main() {
  const args = parseArgs();
  const [referencePath, inputPath] = documentPathsFromArgs(args);
  const client = new Isaacus({ apiKey: process.env.ISAACUS_API_KEY });
  await runComparison(client, referencePath, inputPath, { useCache: !args.noCache, label: args.label });
}

if (import.meta.main) {
  await main();
}
