import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { parseArgs as parseNodeArgs } from "node:util";
import { execFile } from "node:child_process";

import { DOCUMENTS_DIR } from "./document_index.js";
import { sliceText, splitText, textLength } from "./helpers/unicode.js";
import { mapPool, readJson, comparisonDirFor, documentPathsFromArgs } from "./document_analysis.js";

export const MODEL = "claude-cli-opus";
export const MAX_TOKENS = 32000;

export const BATCH_SIZE = 15; export const MAX_PARALLEL_BATCHES = 20;
export const ATTEMPTS = 2; export const TIMEOUT_SECONDS = 15 * 60;

export const DOCUMENTS = `<reference_document>
{reference}
</reference_document>

<input_document>
{input}
</input_document>`;

export const PARTIES_PROMPT = `Below is an input document. Identify its major parties: the people or organisations that sign it or are bound by it as a party. Leave out anyone who is only mentioned, such as affiliates, third parties or regulators. If the input document is not an agreement (for example, legislation or a policy), list instead the main groups it binds or protects, such as "employers" and "employees".

Respond with ONLY a JSON array, no prose and no markdown code fences, of {"id": short lowercase slug, "name": the name as the input document gives it (e.g. "The Walt Disney Company", "Robert A. Iger", or a role like "the Customer" if the input document names no one), "role": a few words on who they are in this deal}.

<input_document>
{input}
</input_document>`;

export const RECOMMEND_PROMPT = (
  `You are a senior lawyer. A client checks an input document against its standard, the reference document. For each finding in <findings>, write summaries, a comment, a recommendation for each party to the input document and a rewrite. <all_findings> lists every finding in this review as context; several can be on the same point.

Read both documents in full first. A finding is what a detector matched, not a confirmed difference or absence, so check it against both documents. Read qualifiers exactly ("to the extent", "unless"). Never describe a limited rule as unlimited.

Parties to the input document:
{parties}

Kinds of finding: "changed" (an input passage matched with one or more reference passages that may differ from it), "added" (an input passage that matched no reference passage) and "missing" (a reference passage that matched no input passage).

Judge each finding against the input document as it is now, never against a rewrite that you give for another finding.

Fields:
- "summaries": for a reader who skims the findings. One or two sentences each, 40 words at most. For "changed", give one per reference passage, in order: start with "The input document", then say what the reference document does instead, with the exact amount, date, condition or party that differs and its qualifiers. If only the wording differs, write exactly "Same in substance; only the wording differs." instead. For "added" and "missing", give one: what the passage secures and for which party, with its qualifiers. Never say what happens without it or that another clause lacks it.
- "falsePositive": true only if, with both full documents in view, no part of the finding changes the effect. One equivalent reference passage does not make the whole finding false. A different law, price, amount or date is a real difference.
- "comment": two to four sentences: what the input document does, what the reference document does instead, and which party this favours and why. Cite a reference clause by the number and heading it has, for example "Section 4.1 (Fees) of the reference document", after you check them.
- "referenceQuotes": exact excerpts, 80 words at most each, from other reference passages that the comment relies on. [] if none.
- "parties": for each party id, from that party's point of view:
  - "action", in this order: "ignore" if the finding is a false positive; null if it is a commercial choice, such as a price, salary or date; else "rewrite" if the rewrite helps the party, "remove" if the party gains most when the whole input passage goes (not for "missing", nor when another clause refers to it), or "ignore".
  - "reason": one sentence on what the party gains or loses, in concrete terms. Name another input clause only if it already gives the same result.
- "rewrite": the passage at the reference document's position. For "changed", redraft the input passage. For "added", narrow or qualify it toward the reference position, or give null if that position is to have no such passage. For "missing", draft the clause to insert, and cover only this finding's reference passage.
- "insertAfter": for "missing", copy exactly the end of the input document paragraph that the new clause follows: its last 8 to 15 words, or all of it if it is shorter, with its punctuation and Markdown. These words must occur only once in the input document. Choose the place a lawyer would choose: in the right section, after the most related clause. Else null.

Summaries, comment and reasons:
- Write ASD-STE100 Simplified Technical English: active voice, one idea per sentence, no sentence over 20 words, common words with one meaning.
- Use plain words for legal ideas: "a chance to fix the problem first", not "a cure period". Never write "shall", "herein", "pursuant to", "notwithstanding", "the foregoing" or "in respect of".
- Call the documents "the input document" and "the reference document", never by title or year. Name each party, for example "the Customer". Never "You" or "We".
- Never mention finding ids, the detector, this review or the rewrite. Plain text, no Markdown.
- They must agree with each other. Check each of them against the exact words of the passages before you answer.

Rewrite:
- Write it as part of the input document, in its drafting style: its defined terms, party names, capitalisation, legal words and cross-reference style, in Markdown. Adapt the reference wording to the input document. Never cite a reference section number or use a term the input document does not define.
- Go no further than the reference position. Never limit or widen an obligation the finding is not about.
- "changed" and "added": change only what the finding is about. Keep all other words, numbering, list markers and line structure.
- "missing": write the whole clause, numbered to fit its place.
- The rewrite must not contradict or repeat another clause. If it must override a clause that this finding cannot change, start with "Despite Section X,". After you move or add words, check that "this" and "such" still point to the right thing.
- Where a rule depends on who acts, say who.

Respond with ONLY one JSON object, no prose and no code fences. Map each finding id in <findings>, exactly as given, to:
{"summaries": [string], "falsePositive": boolean, "comment": string, "referenceQuotes": [string], "parties": {<party id>: {"action": "ignore" | "remove" | "rewrite" | null, "reason": string}}, "rewrite": string (null only for "added"), "insertAfter": string or null}
Include each of those finding ids once, and every party id in each.

`
    + DOCUMENTS
    + `

<all_findings>
{index}
</all_findings>

<findings>
{findings}
</findings>`
);

async function callModel(prompt, { model, apiKey, timeout = TIMEOUT_SECONDS }) {
  const messages = [{ role: "user", content: prompt }];

  if (model.startsWith("claude-cli-")) {
    const result = await new Promise((resolve, reject) => {
      const proc = execFile("claude", [
        "-p", "--model", model.replace(/^claude-cli-/, ""),
        "--output-format", "text", "--allowedTools", "", "--no-session-persistence",
      ], { timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
        } else {
          resolve({ returncode: proc.exitCode, stdout, stderr });
        }
      });
      proc.stdin.end(prompt);
    });

    if (result.returncode !== 0) {
      throw new Error(`claude CLI exited ${result.returncode}: ${result.stderr.trim().slice(0, 300)}`);
    }

    return result.stdout;
  }

  if (model.startsWith("claude")) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const reply = await new Anthropic({ apiKey, timeout: timeout * 1000 }).messages.create({
      model, max_tokens: MAX_TOKENS, messages,
    });

    return reply.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }

  if (model.startsWith("gpt")) {
    const { default: OpenAI } = await import("openai");
    const reply = await new OpenAI({ apiKey, timeout: timeout * 1000 }).chat.completions.create({ model, messages });

    return reply.choices[0].message.content || "";
  }

  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeout * 1000 } });

  return (await client.models.generateContent({ model, contents: prompt })).text || "";
}

export function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (Object.hasOwn(values, key) ? values[key] : whole));
}

function firstWords(text, length = 140) {
  const flat = splitText(text).join(" ");

  return textLength(flat) > length ? `${sliceText(flat, 0, length)}…` : flat;
}

function jsonIn(text, opening, closing) {
  return JSON.parse(text.slice(text.indexOf(opening), text.lastIndexOf(closing) + 1));
}

function trimmed(value) {
  return value ? String(value).trim() || null : null;
}

export function locate(text, quote) {
  if (!quote) {
    return null;
  }

  const at = text.indexOf(quote);

  if (at >= 0) {
    const start = textLength(text.slice(0, at));

    return { start, end: start + textLength(quote) };
  }

  const positions = [];
  const flat = [];

  for (const [n, char] of Array.from(text).entries()) {
    if (/\s/.test(char) && flat.at(-1) === " ") {
      continue;
    }

    flat.push(/\s/.test(char) ? " " : char);
    positions.push(n);
  }

  const needle = quote.replace(/\s+/g, " ").trim();
  const joined = flat.join("");
  const found = joined.indexOf(needle);

  if (!needle || found < 0) {
    return null;
  }

  const first = textLength(joined.slice(0, found));

  return { start: positions[first], end: positions[first + textLength(needle) - 1] + 1 };
}

export function insertionPoint(input, quote) {
  const span = locate(input, quote);

  if (span === null) {
    return null;
  }

  const rest = sliceText(input, span.end);
  const lineEnd = rest.indexOf("\n");

  return lineEnd < 0 ? textLength(input) : span.end + textLength(rest.slice(0, lineEnd));
}

function anchor(entry, quote, input) {
  const insertAt = insertionPoint(input, quote);

  if (insertAt === null) {
    return `insertAfter not found in the input document: ${quote}`;
  }

  if (locate(sliceText(input, insertAt), quote)) {
    return `insertAfter occurs more than once in the input document: ${quote}`;
  }

  [entry.insertAfter, entry.insertAt] = [quote, insertAt];

  return null;
}

export function parseAnswer(text, batch, { recommendations, summaries, input, reference }) {
  const answer = jsonIn(text, "{", "}");
  const problems = [];

  for (const finding of batch) {
    const entry = answer[finding.id];

    if (!entry) {
      problems.push(`${finding.id}: no answer`);

      continue;
    }

    const texts = entry.summaries ?? [];

    if (texts.length !== finding.keys.length) {
      problems.push(`${finding.id}: ${texts.length} summaries for ${finding.keys.length} passages`);

      continue;
    }

    const rewrite = trimmed(entry.rewrite);

    if (!rewrite && finding.kind !== "added") {
      problems.push(`${finding.id}: no rewrite`);

      continue;
    }

    const result = {
      falsePositive: entry.falsePositive,
      comment: entry.comment.trim(),
      rewrite,
      parties: Object.fromEntries(recommendations.parties.map((party) => {
        const vote = entry.parties[party.id] ?? {};
        const action = vote.action ?? null;

        return [party.id, {
          action: entry.falsePositive || (finding.kind === "missing" && action === "remove") ? "ignore" : action,
          reason: (vote.reason ?? "").trim(),
        }];
      })),
      references: [],
    };

    for (const quote of entry.referenceQuotes) {
      const span = locate(reference, quote);

      if (span) {
        result.references.push(span);
      } else {
        problems.push(`${finding.id}: reference quote not found (dropped): ${firstWords(quote, 80)}`);
      }
    }

    const problem = finding.kind === "missing" ? anchor(result, trimmed(entry.insertAfter), input) : null;

    if (problem) {
      problems.push(`${finding.id}: ${problem}`);

      continue;
    }

    recommendations.findings[finding.id] = result;
    finding.keys.forEach((key, n) => {
      summaries[key] = texts[n].trim();
    });
  }

  return problems;
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, n) => items.slice(n * size, (n + 1) * size));
}

async function runBatches(findings, save, { ask, template, values, pending, settle, label }) {
  let done = 0;
  let total = 0;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const batches = chunks(findings.filter(pending), BATCH_SIZE);
    total += batches.length;
    await mapPool(batches, MAX_PARALLEL_BATCHES, async (batch) => {
      let problems;

      try {
        problems = settle(await ask(fill(template, {
          ...values, findings: batch.map((f) => f.block).join("\n\n"),
        })), batch);
      } catch (error) {
        problems = [`batch of ${batch.map((f) => f.id).join(", ")} failed: ${error.message}`];
      }

      save();
      done += 1;

      for (const problem of problems) {
        console.error(`${label}: ${problem}`);
      }

      console.log(`${label} ${done}/${total}`);
    });
  }

  const left = findings.filter(pending).length;

  if (left) {
    console.error(`${label}: gave up on ${left} findings`);
  }
}

function exit(message) {
  console.error(message);
  process.exit(1);
}

function readRun(runDir) {
  const file = path.join(runDir, "report.json");
  const report = readJson(file);

  if (report === null) {
    exit(`No saved run in ${runDir}: run document_analysis.js on this pair first`);
  }

  return [file, report];
}

function writeReport(file, report) {
  const scratch = `${file}.tmp`;
  fs.writeFileSync(scratch, JSON.stringify(report, null, 2), "utf8");
  fs.renameSync(scratch, file);
}

function saveRun(file, report, summaries) {
  report.summaries = {
    model: report.recommendations.model,
    matches: report.deviations.flatMap((d) => d.matches.map((_, i) => ({ key: `d${d.id}-${i}`, deviation_id: d.id, match_index: i })))
      .filter((row) => Object.hasOwn(summaries, row.key)).map((row) => ({ ...row, text: summaries[row.key] })),
    gaps: ["reference", "input"].flatMap((side) => report[`gaps_${side}`].map((g) => [`${side[0]}${g.id}`, g])
      .filter(([key]) => Object.hasOwn(summaries, key))
      .map(([key, g]) => ({ key, gap_id: g.id, side, text: summaries[key] }))),
  };
  writeReport(file, report);
}

export async function generateRun(runDir, { model = MODEL, apiKey = null, useCache = true } = {}) {
  const cli = model.startsWith("claude-cli-");
  const key = model.startsWith("claude") ? "ANTHROPIC_API_KEY" : model.startsWith("gpt") ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
  const resolvedKey = apiKey ?? process.env[key];
  const ready = cli
    ? (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
      try {
        fs.accessSync(path.join(dir, "claude"), fs.constants.X_OK);

        return true;
      } catch {
        return false;
      }
    })
    : Boolean(resolvedKey);

  if (!ready) {
    exit(`No client for ${model}: ${cli
      ? "`claude` is not on PATH — install Claude Code, or add the launcher in README.md"
      : `pass apiKey, or set ${key} in .env`}`);
  }

  const [file, report] = readRun(runDir);
  const texts = {};

  for (const side of ["reference", "input"]) {
    const identity = report[side] ?? {};
    const { text } = readJson(path.join(DOCUMENTS_DIR, `${identity.source_sha256}.json`)) ?? {};

    if (text === undefined || crypto.createHash("sha256").update(text).digest("hex") !== identity.text_sha256) {
      exit(`The documents behind ${runDir} have changed: run document_analysis.js on this pair again`);
    }

    texts[side] = text;
  }

  const saved = useCache ? report.recommendations : null;
  const recommendations = report.recommendations = saved?.model === model
    ? saved : { model, parties: null, findings: {} };
  const summaries = Object.keys(recommendations.findings).length
    ? Object.fromEntries([...(report.summaries?.matches ?? []), ...(report.summaries?.gaps ?? [])]
      .map((row) => [row.key, row.text]))
    : {};
  const findings = [
    ...report.deviations.filter((d) => d.matches.length).map(({ id, heading, matches }) => ({
      id: `d${id}-0`,
      kind: "changed",
      heading,
      draft: matches[0].input.span
        ? sliceText(texts.input, matches[0].input.span.start, matches[0].input.span.end) : matches[0].input.text,
      standards: matches.map((m) => m.reference.text),
      keys: matches.map((_, i) => `d${id}-${i}`),
    })),
    ...report.gaps_input.map((g) => (
      { id: `i${g.id}`, kind: "added", heading: g.heading, draft: g.text, standards: [], keys: [`i${g.id}`] }
    )),
    ...report.gaps_reference.map((g) => (
      { id: `r${g.id}`, kind: "missing", heading: g.heading, standards: [g.text], keys: [`r${g.id}`] }
    )),
  ];

  for (const f of findings) {
    f.block = [
      `<finding id="${f.id}" kind="${f.kind}">`,
      f.heading && `Heading: ${f.heading}`,
      f.draft !== undefined && `Input passage:\n${f.draft.trim()}`,
      ...f.standards.map((r, n) => `Reference passage${f.standards.length > 1 ? ` ${n + 1}` : ""}:\n${r.trim()}`),
      "</finding>",
    ].filter(Boolean).join("\n");
  }

  function ask(prompt) {
    return callModel(prompt, { model, apiKey: resolvedKey });
  }

  function save() {
    saveRun(file, report, summaries);
  }

  console.log("STAGE: Finding parties");

  for (let attempt = 1; attempt <= (recommendations.parties?.length ? 0 : ATTEMPTS); attempt++) {
    let rows;

    try {
      rows = jsonIn(await ask(fill(PARTIES_PROMPT, texts)), "[", "]");
    } catch (error) {
      console.error(`Finding parties failed: ${error.message}`);

      continue;
    }

    if (rows.length) {
      recommendations.parties = rows;
      save();

      break;
    }

    console.error("Finding parties failed: the answer named no parties");
  }

  if (!recommendations.parties?.length) {
    exit("Could not find the parties to the input document");
  }

  console.log("STAGE: Summarizing and recommending");
  await runBatches(findings, save, {
    ask,
    template: RECOMMEND_PROMPT,
    values: {
      ...texts,
      parties: recommendations.parties.map((p) => `- ${p.id}: ${p.name} (${p.role})`).join("\n"),
      index: findings.map((f) => `- ${f.id} (${f.kind})${f.heading ? ` ${f.heading}` : ""}: `
        + `${firstWords(f.draft ?? f.standards[0])}`).join("\n"),
    },
    pending: (f) => !Object.hasOwn(recommendations.findings, f.id)
      || f.keys.some((key) => !Object.hasOwn(summaries, key)),
    settle: (text, batch) => parseAnswer(text, batch, { recommendations, summaries, ...texts }),
    label: "Summarizing and recommending",
  });

  return report;
}

async function main() {
  const { values: args } = parseNodeArgs({ options: {
    reference: { type: "string" },
    input: { type: "string" },
    "no-cache": { type: "boolean", default: false },
  } });
  const missing = ["--reference", "--input"].filter((flag) => args[flag.slice(2)] === undefined);

  if (missing.length) {
    console.error(`generation.js: error: the following arguments are required: ${missing.join(", ")}`);
    process.exit(2);
  }

  await generateRun(comparisonDirFor(...documentPathsFromArgs(args)), { useCache: !args["no-cache"] });
}

if (import.meta.main) {
  await main();
}
