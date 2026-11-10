import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { sliceText, textLength } from "../helpers/unicode.js";

process.env.ISAACUS_API_KEY = "offline-parity-test";
const di = await import("../document_index.js");
const da = await import("../document_analysis.js");

function enriched(texts) {
  const text = `# Terms\n\n${texts.join("\n\n")}`;
  const segments = [];
  const terms = [];
  let start = 9;
  for (const [n, paragraph] of texts.entries()) {
    const end = start + textLength(paragraph);
    segments.push({
      id: `seg:${n}`, span: { start, end }, parent: "root", children: [], level: 1,
      kind: "provision", type: null, category: paragraph.includes("Editorial") ? "annotation" : null,
      type_name: null, code: null, title: null,
    });
    if (paragraph.startsWith("The ")) {
      terms.push({ name: { start: start + 5, end: start + 9 }, meaning: { start: start + 11, end } });
    }

    start = end + 2;
  }

  segments.unshift({
    id: "root", span: { start: 0, end: textLength(text) }, parent: null,
    children: segments.map((seg) => seg.id), level: 0, kind: "container", type: null,
    category: null, type_name: null, code: null, title: { start: 2, end: 7 },
  });

  return { text, segments, terms };
}

function score(query, text, kind) {
  if (kind === "classify" && query === da.FILTER_QUERY) {
    return text.includes("Editorial") || text.startsWith("The ") ? 0.9 : 0.1;
  }

  const total = Array.from(`${kind}|${query}|${text}`).reduce((sum, char) => sum + char.codePointAt(0), 0);

  if (kind === "rerank" && query === da.EMPTY_QUERY) {
    return text.includes("Payment") ? 0.001 : 0.8;
  }

  if (kind === "classify" && query === da.MONEY_STATEMENT) {
    return text.includes("Payment") ? 0.99 : 0.1;
  }

  return 0.01 + (total % 91) / 100_000;
}

function close(actual, expected, label = "result") {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", label);
    assert.ok(Math.abs(actual - expected) <= 1e-5, `${label}: ${actual} != ${expected}`);

    return;
  }

  if (expected === null || typeof expected !== "object") {
    assert.equal(actual, expected, label);

    return;
  }

  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label} keys`);
  for (const key of Object.keys(expected)) {
    close(actual[key], expected[key], `${label}.${key}`);
  }
}

test("index and analysis stages match Python with identical offline model responses", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "isaacus-pipeline-"));
  const client = { classifications: { universal: {} }, rerankings: {}, embeddings: {}, enrichments: {} };
  const careQueries = [];
  try {
    client.classifications.universal.create = async ({ query, texts }) => {
      if (query.startsWith(da.CARE_STATEMENT.split("{clause}")[0])) {
        careQueries.push(query);
      }

      return {
        classifications: texts.map((text, index) => ({ index, score: score(query, text, "classify") })).reverse(),
      };
    };
    client.rerankings.create = async ({ query, texts }) => ({
      results: texts.map((text, index) => ({ index, score: score(query, text, "rerank") })).reverse(),
    });
    const documents = [
      enriched(["😀", "Payment is due in 30 days.", 'The "Term" means one year.', "𐐀", "Editorial note.",
        `${"😀".repeat(2001)} Payment is due.`, "\u2002Ordinary text."]),
      enriched(["😀", "Payment is due in 60 days.", 'The "Term" means two years.', "𐐀", "Editorial note.",
        `${"😀".repeat(2001)} Payment is due.`, "An additional obligation."]),
    ];
    const paths = documents.map((doc, n) => {
      const file = path.join(temporary, `document-${n}.md`);
      fs.writeFileSync(file, doc.text);

      return file;
    });
    const indexes = documents.map((doc, n) => {
      const propositions = di.extractClauses(`document-${n}.md`, doc);

      return di.createDocumentIndex({
        propositions,
        embeddings: di.unitNormalize(propositions.map((_, i) => (
          i === propositions.length - 1 ? (n === 0 ? [-1, 0, 0] : [0, 0, -1]) : [1, (i + 1) / 10, n / 100]
        ))),
        text: doc.text,
        sections: di.documentSections(doc),
      });
    });
    const jsCacheDirs = indexes.map((index, n) => di.writeIndex(index, path.join(temporary, `js-${n}`)));
    const data = {
      documents, paths,
      embedding_texts: Array.from({ length: di.EMBED_BATCH_SIZE + 1 }, (_, n) => `😀 text ${n}`),
      extractions: [
        { text: "😀\nPayment is due.", segments: [{ ...documents[0].segments[1],
          span: { start: 2, end: 17 }, parent: null }], terms: [] },
        { text: "𐐀", segments: [{ ...documents[0].segments[1],
          span: { start: 0, end: 1 }, parent: null }], terms: [] },
        { text: "😀\n# ١. Heading\n\nBody.", segments: [{ ...documents[0].segments[1],
          span: { start: 16, end: 21 }, parent: null }], terms: [] },
      ],
      vectors: indexes.map((index, n) => index.propositions.map((_, i) => (
        i === index.propositions.length - 1 ? (n === 0 ? [-1, 0, 0] : [0, 0, -1]) : [1, (i + 1) / 10, n / 100]
      ))),
      python_run_dir: path.join(temporary, "python-run"),
      documents_dir: path.join(temporary, "python-documents"),
      cache_dirs: indexes.map((_, n) => path.join(temporary, `python-${n}`)),
      js_cache_dirs: jsCacheDirs,
      scores: [
        { relevance: 0.9, match: 0, empty: 0, care: 0, agree: 0, money: 1 },
        { relevance: 0.5, match: -10, empty: 1, care: 1, agree: 1, money: 0 },
        { relevance: 0.7, match: -1, empty: 0.1, care: 0.2, agree: 0.3, money: 0.4 },
      ],
      matrices: [[], [[0.5]], Array.from({ length: 35 }, (_, i) => (
        Array.from({ length: 35 }, (_, j) => 0.5 + ((i * 7 + j * 3) % 4) / 10)
      ))],
    };
    const root = fileURLToPath(new URL("../../python", import.meta.url));

    const venvPython = path.join(root, ".venv", "bin", "python");
    const python = process.env.PYTHON_BIN ?? (fs.existsSync(venvPython) ? venvPython : "python3");
    const embeddingCalls = [];
    client.embeddings.create = async ({ model, texts, task }) => {
      assert.equal(model, di.EMBEDDER_MODEL);
      assert.equal(task, "retrieval/document");
      embeddingCalls.push(texts.length);

      return { embeddings: texts.map((text) => ({ embedding: [
        textLength(text), Array.from(text).reduce((sum, char) => sum + char.codePointAt(0), 0) % 17, 1,
      ] })) };
    };
    client.enrichments.create = async (options) => {
      assert.deepEqual(options, {
        model: di.ENRICHER_MODEL, texts: documents[0].text, overflow_strategy: "auto",
      });

      return { results: [{ document: documents[0] }] };
    };
    const enrichedDoc = await di.enrichDocument(client, documents[0].text);
    const embedded = await di.embedPropositions(client, data.embedding_texts);
    assert.deepEqual(embeddingCalls, [di.EMBED_BATCH_SIZE, 1]);

    const fixturePath = path.join(temporary, "fixtures.json");
    fs.writeFileSync(fixturePath, JSON.stringify(data));
    const result = spawnSync(python, ["-B", fileURLToPath(new URL("./pipeline_reference.py", import.meta.url)), fixturePath], {
      timeout: 30_000, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ISAACUS_API_KEY: "offline-parity-test" },
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = JSON.parse(result.stdout);
    const [input, reference] = indexes;
    const filtered = [await da.nonOperative(client, input), await da.nonOperative(client, reference)];
    const sim = da.pairMatrix(input, reference);

    const shortlist = da.shortlistPairs(da.maskNonOperative(sim, ...filtered), { minRelevance: 0.5, topK: 3 });
    const scored = await da.scorePairs(client, input, reference, { shortlist });
    const [deviating, inputStatus, referenceStatus] = da.partition(input, reference, scored);
    const deviationRows = da.rollUpDeviations(deviating, input, reference);
    const gapsReference = da.rollUpGaps(reference, referenceStatus, { other: input, filtered: filtered[1] });
    const gapsInput = da.rollUpGaps(input, inputStatus, { other: reference, filtered: filtered[0] });
    const pairs = da.scoredPairsRows(input, reference, scored, {
      deviating: new Set(deviating.map(([i, j]) => `${i}:${j}`)),
    });
    const report = await da.buildReport({
      reference, input, referencePath: paths[1], inputPath: paths[0], deviationRows,
      gapsReference, gapsInput, inputStatus, referenceStatus,
      inputFiltered: filtered[0], referenceFiltered: filtered[1], pairs,
    });

    const structure = {};
    for (const name of ["document_index", "document_analysis"]) {
      const source = fs.readFileSync(new URL(`../${name}.js`, import.meta.url), "utf8");
      const factories = { createClause: "Clause", createDocumentIndex: "DocumentIndex", createPairScore: "PairScore" };
      const functions = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)]
        .map((match) => match[1]).filter((fn) => !["npLoad", "npSave", "mapPool"].includes(fn));
      const expectedNames = expected.structure[name].functions;
      structure[name] = {
        regions: [...source.matchAll(/^\/\/ region (.+)$/gm)].map((match) => match[1]),
        functions: functions.map((fn) => {
          if (factories[fn]) {
            return factories[fn];
          }

          const snake = fn.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

          return expectedNames.includes(snake) ? snake : `_${snake}`;
        }),
      };
    }

    const actual = {
      structure,
      enriched: enrichedDoc.text,
      embedded: Array.from({ length: embedded.shape[0] }, (_, n) => (
        Array.from(embedded.data.slice(n * 3, (n + 1) * 3))
      )),
      extractions: data.extractions.map((doc) => di.extractClauses("edge.md", doc)),
      clauses: indexes.map((index) => index.propositions),
      sections: indexes.map((index) => index.sections),
      embeddings: indexes.map((index) => Array.from({ length: index.embeddings.shape[0] }, (_, i) => (
        Array.from(index.embeddings.data.slice(i * 3, (i + 1) * 3))
      ))),
      filtered, similarity: sim, shortlist: [...shortlist],
      scored: [...scored].map(([key, { relevance, match, empty, care, agree, money }]) => [
        key, { relevance, match, empty, care, agree, money },
      ]),
      report,
      params: da.analysisParams(),
      scores: data.scores.map((item) => {
        const sc = da.createPairScore(item);

        return [sc.sameMatter, sc.materiality, sc.differs, sc.conflict];
      }),
      shortlists: data.matrices.map((matrix) => [...da.shortlistPairs(matrix, { minRelevance: 0.5, topK: 3 })]),
      cached: indexes.map((index) => Array.from({ length: index.embeddings.shape[0] }, (_, i) => (
        Array.from(index.embeddings.data.slice(i * 3, (i + 1) * 3))
      ))),
    };
    close(JSON.parse(JSON.stringify(actual)), expected);
    assert.ok(report.deviations.length > 0, "exercise deviation selection and roll-up");
    assert.ok(report.gaps_input.length > 0 && report.gaps_reference.length > 0, "exercise gaps on both sides");
    close(await da.savedReportIfCurrent(data.python_run_dir, paths[1], paths[0]),
      Object.fromEntries(Object.entries(expected.report).filter(([key]) => key !== "pairs")), "Python saved report");
    for (const [n, index] of indexes.entries()) {
      const cached = di.readIndex(data.cache_dirs[n]);
      close(cached.propositions, JSON.parse(JSON.stringify(index.propositions)), `cache ${n} clauses`);
      close(Array.from(cached.embeddings.data), Array.from(index.embeddings.data), `cache ${n} embeddings`);
    }

    assert.ok(careQueries.some((query) => (
      textLength(query) === textLength(da.CARE_STATEMENT.replace("{clause}", "")) + da.CLASSIFY_QUERY_MAX_CHARS
    )), "exercise query truncation at a Unicode code-point boundary");
    assert.ok(indexes[0].propositions.some((clause) => clause.definition), "retain definitions despite filter scores");

    const runDir = path.join(temporary, "run");
    await da.writeAnalysisRun(report, {
      reference, input, referencePath: paths[1], inputPath: paths[0], runDir,
      documentsDir: path.join(temporary, "documents"),
    });
    const savedReport = await da.savedReportIfCurrent(runDir, paths[1], paths[0]);
    assert.ok(savedReport);
    fs.writeFileSync(fixturePath, JSON.stringify({ ...data, read_run: runDir }));
    const cachedResult = spawnSync(python, ["-B",
      fileURLToPath(new URL("./pipeline_reference.py", import.meta.url)), fixturePath], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ISAACUS_API_KEY: "offline-parity-test" },
    });
    assert.equal(cachedResult.status, 0, cachedResult.stderr);
    close(JSON.parse(cachedResult.stdout), savedReport, "JavaScript report read by Python");

    fs.appendFileSync(paths[0], "\nChanged.");
    assert.equal(await da.savedReportIfCurrent(runDir, paths[1], paths[0]), null);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Unicode offsets follow code points", () => {
  assert.equal(sliceText("😀\nPayment is due.", 2, 17), "Payment is due.");
});
