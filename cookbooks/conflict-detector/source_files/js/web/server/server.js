import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { parseArgs } from "node:util";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import multer from "multer";
import express from "express";
import yaml from "js-yaml";

import { SCHEMA, REPORTS_DIR, readJson, pairSlug, comparisonDirFor } from "../../document_analysis.js";
import { REPO_ROOT, SAMPLES_DIR, DOCUMENTS_DIR } from "../../document_index.js";

const WORKSPACE_ROOT = path.dirname(path.dirname(import.meta.dirname));
const UPLOADS_DIR = path.join(SAMPLES_DIR, "uploads");

const SIDES = ["reference", "input"];
const ORIGINS = [
  ["sample", "Samples", SAMPLES_DIR],
  ["uploaded", "Your uploads", UPLOADS_DIR],
];

const SAMPLE_TITLES = {
  "08-disney-iger-employment-agreement-2022.md": "Disney / Robert A. Iger Employment Agreement (2022)",
  "09-disney-iger-amended-restated-employment-agreement-2011.md": "Disney / Robert A. Iger Amended and Restated Employment Agreement (2011)",
  "03-common-paper-cloud-service-agreement.md": "Common Paper Cloud Service Agreement",
  "04-mistral-ai-terms-of-use.md": "Mistral AI Terms of Use",
  "02-google-play-developer-distribution-agreement.md": "Google Play Developer Distribution Agreement",
  "05-boeing-tmssequoia-corporate-software-license-agreement.md": "Boeing / TMSSequoia Corporate Software License Agreement",
  "06-common-paper-mutual-nda.md": "Common Paper Mutual Non-Disclosure Agreement",
  "07-intel-cloudera-confidentiality-agreement.md": "Intel / Cloudera Confidentiality Agreement",
  "10-enron-frevert-executive-employment-agreement-1998.md": "Enron / Mark A. Frevert Executive Employment Agreement (1998)",
};

const UPLOAD_SUFFIXES = [".md", ".markdown", ".txt"];
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const ANALYSIS_TIMEOUT_SECONDS = 60 * 60;

const app = express();
app.use(express.static(path.join(WORKSPACE_ROOT, "web", "client")));
app.use(express.json({ limit: MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES }));
const upload = multer({ limits: { fileSize: MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES } });

const analysis = { state: "idle", progress: null, message: null, run_id: null, reference: null, input: null, label: null, cached: null, started_at: null };
let reviewing = false;

const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile();

function relative(file) {
  return path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join("/");
}

function scanDocument(file, origin, originLabel) {
  const match = /^---([\s\S]*?)---/.exec([...fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n")].slice(0, 4096).join(""));
  let fm = null;
  try {
    fm = match ? yaml.load(match[1]) : null;
  } catch {}

  const title = fm !== null && typeof fm === "object" && !Array.isArray(fm) ? fm.title : null;

  return {
    path: relative(file),
    name: path.basename(file),
    origin,
    origin_label: originLabel,
    title: title || SAMPLE_TITLES[path.basename(file)] || path.parse(file).name.replaceAll("-", " ")
      .replace(/\p{Cased}+/gu, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
  };
}

function pickerPayload() {
  const documents = ORIGINS.flatMap(([origin, label, root]) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }) : [])
    .map((name) => path.join(root, name))
    .filter((p) => (root !== SAMPLES_DIR || path.dirname(p) === SAMPLES_DIR) && isFile(p) && [".md", ".markdown"].includes(path.extname(p).toLowerCase())
      && !["theme.yaml", "readme.md"].includes(path.basename(p).toLowerCase()))
    .sort()
    .map((p) => scanDocument(p, origin, label)));

  return {
    upload: { accept: [...UPLOAD_SUFFIXES], max_bytes: MAX_UPLOAD_BYTES },
    ...Object.fromEntries(SIDES.map((side) => [side, { documents }])),
  };
}

function resolveSidePath(raw, _side, what) {
  if (!raw) throw new RangeError(`${what} is required`);

  const roots = ORIGINS.map(([, , root]) => path.resolve(root));
  const options = [path.resolve(REPO_ROOT, raw), ...roots.map((root) => path.resolve(root, raw))];
  const resolved = options.find(isFile) ?? options[0];
  if (!roots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
    throw new RangeError(`${what} must be inside ${roots.map(relative).join(" or ")}`);
  }

  if (!isFile(resolved)) throw new RangeError(`${what} not found: ${raw}`);

  return resolved;
}

function pairPaths(args, suffix = "") {
  return SIDES.map((side) => resolveSidePath(args[side + suffix], side, `${side[0].toUpperCase()}${side.slice(1)} document`));
}

function savedReport(folder) {
  const report = readJson(path.join(folder, "report.json"));
  const valid = !!report && typeof report === "object" && report.schema === SCHEMA
    && !!report.summary && typeof report.summary === "object";

  return valid ? report : null;
}

function committed(folder, since = 0) {
  const stat = fs.statSync(path.join(folder, "params.json"), { throwIfNoEntry: false });

  return !!stat && stat.mtimeMs >= since && savedReport(folder) !== null;
}

function runScript(name, referencePath, inputPath, ...extra) {
  return spawn(process.execPath, [path.join(WORKSPACE_ROOT, name), "--reference", referencePath, "--input", inputPath, ...extra], {
    cwd: WORKSPACE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function relay(proc, emit, suffix = "", extra = {}) {
  const lines = [];
  const onLine = (line) => {
    line = line.trimEnd();
    if (line) lines.push(line);

    const match = /(\d+)\/(\d+)/.exec(line);
    if (line.startsWith("STAGE: ")) emit({ type: "status", message: line.slice(7) + suffix });
    else if (match && Number(match[2]) > 0) emit({ type: "progress", done: Number(match[1]), total: Number(match[2]), ...extra });
  };
  await Promise.all([proc.stdout, proc.stderr].map((stream) => once(readline.createInterface({ input: stream }).on("line", onLine), "close")));

  return lines.slice(-8).join("\n").trim();
}

async function runDocumentAnalysis(emit, referencePath, inputPath, label, refresh) {
  const [referenceName, inputName] = [path.basename(referencePath), path.basename(inputPath)];
  const startedAt = new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  Object.assign(analysis, { state: "running", progress: null, message: "Starting analysis…", error: null, run_id: null, reference: referenceName, input: inputName, label, cached: null, started_at: startedAt });

  const record = (event) => {
    if (event.type === "status") analysis.message = event.message;
    else analysis.progress = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type"));
    emit(event);
  };

  try {
    const dest = comparisonDirFor(referencePath, inputPath);
    emit({ type: "started", reference: referenceName, input: inputName });
    const cached = !refresh && committed(dest);
    if (cached) {
      record({ type: "status", message: "Reused this pair's cached run" });
    } else {
      record({ type: "status", message: `Comparing ${inputName} against ${referenceName}…` });
      const existedBefore = fs.existsSync(dest);
      const started = Date.now();
      const deadline = performance.now() + ANALYSIS_TIMEOUT_SECONDS * 1000;
      const proc = runScript("document_analysis.js", referencePath, inputPath, "--label", label, ...(refresh ? ["--no-cache"] : []));
      const tail = [];
      const reader = relay(proc, record, "…", { document: inputName }).then((text) => tail.push(text));
      const exited = once(proc, "exit").then(([code, signal]) => code ?? signal);
      try {
        while (true) {
          if (committed(dest, started)) {
            proc.kill("SIGKILL");
            break;
          }

          const rc = await Promise.race([exited, sleep(500)]);
          if (rc === undefined) {
            if (performance.now() < deadline) continue;
            proc.kill("SIGKILL");
            throw new Error(`document_analysis.js exceeded ${ANALYSIS_TIMEOUT_SECONDS}s and was stopped`);
          }

          await Promise.race([reader, sleep(5000)]);
          if (rc !== 0) throw new Error(tail.join("") || "document_analysis.js failed");
          if (!committed(dest)) throw new Error(`Analysis wrote no readable run to ${relative(dest)}`);
          break;
        }
      } catch (error) {
        if (!existedBefore) fs.rmSync(dest, { recursive: true, force: true });
        throw error;
      }

      record({ type: "status", message: "Summarizing and recommending…" });
      const generation = runScript("generation.js", referencePath, inputPath);
      const errors = [];
      generation.stderr.on("data", (chunk) => errors.push(chunk));
      generation.stdout.resume();
      const [code] = await once(generation, "close");
      if (code !== 0) console.error(`generation.js failed; the run keeps summaries: null\n${Buffer.concat(errors).toString().slice(-2000)}`);

      record({ type: "status", message: "Analysis complete" });
    }

    const id = path.basename(dest);
    Object.assign(analysis, { state: "done", progress: null, message: cached ? "Reused this pair's cached run" : "Analysis complete", run_id: id, cached });
    emit({ type: "ready", cached, run: { id } });

    return { run: { id, cached } };
  } catch (error) {
    Object.assign(analysis, { state: "error", progress: null, message: null, error: error.message });
    throw error;
  }
}

async function runReviews(emit, referencePath, inputPath) {
  if (reviewing) throw new Error("Recommendations are already being written for a pair");

  reviewing = true;
  try {
    emit({ type: "status", message: "Starting" });
    const proc = runScript("generation.js", referencePath, inputPath);
    const closed = once(proc, "close");
    const tail = await relay(proc, emit);
    const [code] = await closed;
    if (code !== 0) throw new Error(tail || "generation.js failed");
  } finally {
    reviewing = false;
  }
}

function sse(res, worker, ...args) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "close",
    "X-Accel-Buffering": "no",
  });

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  worker(send, ...args).then(
    (result) => send({ type: "complete", ...result }),
    (error) => send({ type: "error", message: error.message }),
  ).finally(() => {
    clearInterval(heartbeat);
    res.end();
  });
}

app.get("/", (_req, res) => res.sendFile(path.join(WORKSPACE_ROOT, "web", "client", "index.html")));

app.get("/api/analysis/status", (_req, res) => {
  res.json(Object.fromEntries(Object.entries(analysis).filter(([key, value]) => key !== "error" || value)));
});

app.post("/api/uploads", upload.any(), (req, res) => {
  const targets = SIDES.flatMap((side) => (req.files ?? [])
    .filter((f) => f.fieldname === `${side}_file` && f.originalname).map((f) => [side, f]));
  if (!targets.length) return res.status(400).json({ error: "No files were uploaded" });

  if (targets.length > MAX_UPLOAD_FILES) return res.status(400).json({ error: `At most ${MAX_UPLOAD_FILES} files at a time` });

  const saved = [];
  const errors = [];
  for (const [side, storage] of targets) {
    const name = Buffer.from(storage.originalname, "latin1").toString("utf8");
    let text;
    try {
      if (!UPLOAD_SUFFIXES.includes(path.extname(name).toLowerCase())) {
        throw new RangeError(`${name} is not a supported type (${UPLOAD_SUFFIXES.join(", ")})`);
      }

      if (storage.buffer.length > MAX_UPLOAD_BYTES) {
        throw new RangeError(`${name} exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit`);
      }

      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(storage.buffer);
      } catch {
        throw new RangeError(`${name} is not UTF-8 text`);
      }

      if (!text.trim()) throw new RangeError(`${name} is empty`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const stem = path.parse(name).name.normalize("NFKD").replace(/[^\x00-\x7F]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 80) || "upload";
    const root = path.join(UPLOADS_DIR, side);
    fs.mkdirSync(root, { recursive: true });
    let dest = path.join(root, `${stem}.md`);
    for (let counter = 2; fs.existsSync(dest); counter += 1) dest = path.join(root, `${stem}-${counter}.md`);

    fs.writeFileSync(dest, text, "utf8");
    saved.push({ side, ...scanDocument(dest, ...ORIGINS.at(-1)) });
  }

  if (!saved.length) return res.status(400).json({ error: errors.join("; ") || "No files were saved" });

  return res.status(201).json({ uploaded: saved, ...pickerPayload() });
});

app.get("/api/catalog", (_req, res) => {
  const payload = pickerPayload();
  const pairs = {};
  for (const ref of payload.reference.documents) {
    for (const inc of payload.input.documents) {
      const folder = path.join(REPORTS_DIR, pairSlug(ref.path, inc.path));
      const report = savedReport(folder);
      if (report === null) continue;

      const params = readJson(path.join(folder, "params.json")) ?? {};
      pairs[path.basename(folder)] = {
        reference_path: ref.path,
        input_path: inc.path,
        run_id: path.basename(folder),
        created_at: params.created_at ?? null,
        label: params.label ?? null,
        summary: report.summary,
      };
    }
  }

  res.json({ ...payload, pairs });
});

app.get("/api/run", (req, res) => {
  const pair = pairSlug(...pairPaths(req.query));
  const report = savedReport(path.join(REPORTS_DIR, pair));
  if (report === null) return res.status(404).json({ error: `No cached run for ${pair}` });

  const texts = Object.fromEntries(SIDES.map((side) => [`${side}_text`,
    readJson(path.join(DOCUMENTS_DIR, `${(report[side] || {}).source_sha256}.json`))?.text ?? ""]));

  return res.json({ report, ...texts });
});

app.get("/api/reviews", (req, res) => {
  const pair = pairSlug(...pairPaths(req.query));
  const reviews = readJson(path.join(REPORTS_DIR, pair, "report.json"))?.recommendations;
  if (!reviews || typeof reviews.findings !== "object") return res.status(404).json({ error: `No recommendations for ${pair}` });

  return res.json(reviews);
});

app.post("/api/reviews/stream", (req, res) => sse(res, runReviews, ...pairPaths(req.body ?? {}, "_path")));

app.post("/api/analyze/stream", (req, res) => {
  const body = req.body ?? {};
  const paths = pairPaths(body, "_path");
  if (analysis.state === "running") return res.status(409).json({ error: "An analysis is already in progress" });

  return sse(res, runDocumentAnalysis, ...paths, body.label || "Server run", Boolean(body.refresh));
});

app.use((error, _req, res, next) => (error instanceof RangeError ? res.status(400).json({ error: error.message }) : next(error)));

if (import.meta.main) {
  const { values: args } = parseArgs({ options: {
    port: { type: "string", default: "5000" },
    host: { type: "string", default: "127.0.0.1" },
  } });
  app.listen(Number(args.port), args.host, () => console.log(`Serving on http://${args.host}:${args.port}`));
}
