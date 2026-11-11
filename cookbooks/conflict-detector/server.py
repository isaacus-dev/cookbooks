import re
import sys
import json
import queue
import hashlib
import threading
import unicodedata

from pathlib import Path
from datetime import UTC, datetime
from urllib.parse import urlencode

from flask import Flask, jsonify, request, Response, stream_with_context
from werkzeug.serving import make_server

import generation

from generation import read_json, DOCUMENTS_DIR

ROOT = Path(__file__).resolve().parent
SAMPLES_DIR = ROOT / "samples"
UPLOADS_DIR = SAMPLES_DIR / "uploads"
REPORTS_DIR = ROOT / "results" / "reports"

SCHEMA = "doc-compare/2"

SIDES = ("reference", "input")
ORIGINS = (
    ("sample", "Samples", SAMPLES_DIR),
    ("uploaded", "Your uploads", UPLOADS_DIR),
)

SAMPLE_TITLES = {
    "08-disney-iger-employment-agreement-2022.md": "Disney / Robert A. Iger Employment Agreement (2022)",
    "09-disney-iger-amended-restated-employment-agreement-2011.md": "Disney / Robert A. Iger Amended and Restated Employment Agreement (2011)",
    "04-mistral-ai-terms-of-use.md": "Mistral AI Terms of Use",
    "03-common-paper-cloud-service-agreement.md": "Common Paper Cloud Service Agreement",
    "06-common-paper-mutual-nda.md": "Common Paper Mutual Non-Disclosure Agreement",
    "07-intel-cloudera-confidentiality-agreement.md": "Intel / Cloudera Confidentiality Agreement",
}

UPLOAD_SUFFIXES = (".md", ".markdown", ".txt")
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_FILES = 20

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES

_pipeline = {"run_comparison": None, "client": None, "model": generation.MODEL, "api_key": None}
_analysis = {"state": "idle", "progress": None, "message": None, "run_id": None, "reference": None, "input": None, "label": None, "cached": None, "started_at": None}
_reviewing = threading.Lock()
_server = None


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "document"


def pair_slug(reference_path, input_path) -> str:
    return f"{slug(Path(reference_path).stem)}__{slug(Path(input_path).stem)}"


class ThreadOutput:
    def __init__(self, fallback):
        self.fallback = fallback
        self.local = threading.local()

    def write(self, text):
        sink = getattr(self.local, "sink", None)
        if sink is None:
            return self.fallback.write(text)

        self.local.buffer = getattr(self.local, "buffer", "") + text
        *lines, self.local.buffer = self.local.buffer.split("\n")
        for line in lines:
            sink(line)

        return len(text)

    def flush(self):
        self.fallback.flush()

    def __getattr__(self, name):
        return getattr(self.fallback, name)


def capture_output(on_line):
    if not isinstance(sys.stdout, ThreadOutput):
        sys.stdout = ThreadOutput(sys.stdout)

    sys.stdout.local.sink, sys.stdout.local.buffer = on_line, ""


def release_output():
    if isinstance(sys.stdout, ThreadOutput):
        sys.stdout.local.sink = None


def line_handler(emit, suffix="", **extra):
    def on_line(line):
        line = line.rstrip()
        if line.startswith("STAGE: "):
            emit({"type": "status", "message": line[7:] + suffix})

        elif (match := re.search(r"(\d+)/(\d+)", line)) and int(match[2]) > 0:
            emit({"type": "progress", "done": int(match[1]), "total": int(match[2]), **extra})

    return on_line


def call(step, *args, **kwargs):
    try:
        return step(*args, **kwargs)

    except SystemExit as exc:
        raise RuntimeError(str(exc.code)) from None


def relative(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def document_title(path):
    match = re.match(r"---(.*?)---", path.read_text(encoding="utf-8", errors="replace")[:4096], re.S)
    title = match and re.search(r"^title:\s*[\"']?(.+?)[\"']?\s*$", match[1], re.M)

    return (title and title[1]) or SAMPLE_TITLES.get(path.name) or path.stem.replace("-", " ").title()


def scan_document(path, origin, origin_label):
    return {"path": relative(path), "name": path.name, "origin": origin, "origin_label": origin_label, "title": document_title(path)}


def listing_order(path):
    titled = list(SAMPLE_TITLES)

    return (titled.index(path.name), "") if path.name in titled else (len(titled), path.as_posix())


def picker_payload():
    documents = [
        scan_document(p, origin, label)
        for origin, label, root in ORIGINS
        for p in sorted(root.rglob("*"), key=listing_order)
        if (root != SAMPLES_DIR or p.parent == SAMPLES_DIR)
        and p.is_file() and p.suffix.lower() in (".md", ".markdown") and p.name.lower() != "readme.md"
    ]

    return {"upload": {"accept": list(UPLOAD_SUFFIXES), "max_bytes": MAX_UPLOAD_BYTES}, **{side: {"documents": documents} for side in SIDES}}


def resolve_side_path(raw, what):
    if not raw:
        raise ValueError(f"{what} is required")

    roots = [root.resolve() for *_, root in ORIGINS]
    options = [ROOT / raw] + [root / raw for root in roots]
    resolved = next((option for option in options if option.is_file()), options[0]).resolve()
    if not any(resolved.is_relative_to(root) for root in roots):
        raise ValueError(f"{what} must be inside {' or '.join(relative(root) for root in roots)}")

    if not resolved.is_file():
        raise ValueError(f"{what} not found: {raw}")

    return resolved


def pair_paths(args, suffix=""):
    return [resolve_side_path(args.get(side + suffix), f"{side.title()} document") for side in SIDES]


def saved_report(folder):
    report = read_json(folder / "report.json")
    valid = isinstance(report, dict) and report.get("schema") == SCHEMA and isinstance(report.get("summary"), dict)

    return report if valid else None


def run_document_analysis(emit, reference_path, input_path, label, refresh):
    reference_name, input_name = reference_path.name, input_path.name
    started_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    _analysis.update(state="running", progress=None, message="Starting analysis…", error=None, run_id=None, reference=reference_name, input=input_name, label=label, cached=None, started_at=started_at)

    def record(event):
        if event["type"] == "status":
            _analysis["message"] = event["message"]

        else:
            _analysis["progress"] = {key: value for key, value in event.items() if key != "type"}

        emit(event)

    try:
        dest = REPORTS_DIR / pair_slug(reference_path, input_path)
        emit({"type": "started", "reference": reference_name, "input": input_name})
        cached = not refresh and saved_report(dest) is not None
        if cached:
            record({"type": "status", "message": "Reused this pair's cached run"})

        else:
            record({"type": "status", "message": f"Comparing {input_name} against {reference_name}…"})
            capture_output(line_handler(record, "…", document=input_name))
            try:
                call(_pipeline["run_comparison"], _pipeline["client"], reference_path, input_path, use_cache=not refresh, label=label)

            finally:
                release_output()

            if saved_report(dest) is None:
                raise RuntimeError(f"Analysis wrote no readable run to {relative(dest)}")

            record({"type": "status", "message": "Summarizing and recommending…"})
            try:
                call(generation.generate_run, dest, model=_pipeline["model"], api_key=_pipeline["api_key"])

            except Exception as exc:
                print(f"Generation failed; the run keeps summaries: null\n{exc}", file=sys.stderr)

            record({"type": "status", "message": "Analysis complete"})

        message = "Reused this pair's cached run" if cached else "Analysis complete"
        _analysis.update(state="done", progress=None, message=message, run_id=dest.name, cached=cached)
        emit({"type": "ready", "cached": cached, "run": {"id": dest.name}})

        return {"run": {"id": dest.name, "cached": cached}}

    except Exception as exc:
        _analysis.update(state="error", progress=None, message=None, error=str(exc))
        raise


def run_reviews(emit, reference_path, input_path):
    if not _reviewing.acquire(blocking=False):
        raise RuntimeError("Recommendations are already being written for a pair")

    try:
        emit({"type": "status", "message": "Starting"})
        capture_output(line_handler(emit))
        call(generation.generate_run, REPORTS_DIR / pair_slug(reference_path, input_path), model=_pipeline["model"], api_key=_pipeline["api_key"])

    finally:
        release_output()
        _reviewing.release()


def sse(worker, *args):
    events = queue.Queue()

    def work():
        try:
            events.put({"type": "complete", **(worker(events.put, *args) or {})})

        except Exception as exc:
            events.put({"type": "error", "message": str(exc)})

        events.put(None)

    def stream():
        while True:
            try:
                event = events.get(timeout=15)

            except queue.Empty:
                yield ": keep-alive\n\n"
                continue

            if event is None:
                return

            yield f"data: {json.dumps(event, default=str)}\n\n"

    threading.Thread(target=work, daemon=True).start()
    headers = {"Cache-Control": "no-cache", "Connection": "close", "X-Accel-Buffering": "no"}

    return Response(stream_with_context(stream()), mimetype="text/event-stream", headers=headers)


@app.errorhandler(ValueError)
def bad_request(exc):
    return jsonify({"error": str(exc)}), 400


@app.get("/")
def index_page():
    return (ROOT / "viewer.html").read_text(encoding="utf-8")


@app.get("/api/analysis/status")
def api_analysis_status():
    return jsonify({key: value for key, value in _analysis.items() if key != "error" or value})


@app.post("/api/uploads")
def api_upload():
    targets = [(side, f) for side in SIDES for f in request.files.getlist(f"{side}_file") if f]
    if not targets:
        return jsonify({"error": "No files were uploaded"}), 400

    if len(targets) > MAX_UPLOAD_FILES:
        return jsonify({"error": f"At most {MAX_UPLOAD_FILES} files at a time"}), 400

    saved, errors = [], []
    for side, storage in targets:
        name = storage.filename or "upload"
        try:
            if Path(name).suffix.lower() not in UPLOAD_SUFFIXES:
                raise ValueError(f"{name} is not a supported type ({', '.join(UPLOAD_SUFFIXES)})")

            payload = storage.read()
            if len(payload) > MAX_UPLOAD_BYTES:
                raise ValueError(f"{name} exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit")

            try:
                text = payload.decode("utf-8")

            except UnicodeDecodeError:
                raise ValueError(f"{name} is not UTF-8 text") from None

            if not text.strip():
                raise ValueError(f"{name} is empty")

        except ValueError as exc:
            errors.append(str(exc))
            continue

        stem = unicodedata.normalize("NFKD", Path(name).stem).encode("ascii", "ignore").decode("ascii")
        stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()[:80] or "upload"
        root = UPLOADS_DIR / side
        root.mkdir(parents=True, exist_ok=True)
        dest, counter = root / f"{stem}.md", 2
        while dest.exists():
            dest, counter = root / f"{stem}-{counter}.md", counter + 1

        dest.write_text(text, encoding="utf-8")
        saved.append({"side": side, **scan_document(dest, *ORIGINS[-1][:2])})

    if not saved:
        return jsonify({"error": "; ".join(errors) or "No files were saved"}), 400

    return jsonify({"uploaded": saved, **picker_payload()}), 201


def saved_pairs(payload):
    pairs = {}
    for ref in payload["reference"]["documents"]:
        for inc in payload["input"]["documents"]:
            folder = REPORTS_DIR / pair_slug(ref["path"], inc["path"])
            if report := saved_report(folder):
                params = read_json(folder / "params.json") or {}
                pairs[folder.name] = {
                    "reference_path": ref["path"],
                    "input_path": inc["path"],
                    "run_id": folder.name,
                    "created_at": params.get("created_at"),
                    "label": params.get("label"),
                    "summary": report["summary"],
                }

    return pairs


@app.get("/api/catalog")
def api_catalog():
    payload = picker_payload()

    return jsonify({**payload, "pairs": saved_pairs(payload)})


@app.get("/api/run")
def api_run():
    paths = pair_paths(request.args)
    pair = pair_slug(*paths)
    report = saved_report(REPORTS_DIR / pair)
    if report is None:
        return jsonify({"error": f"No cached run for {pair}"}), 404

    texts = {f"{side}_text": (read_json(DOCUMENTS_DIR / f"{(report.get(side) or {}).get('source_sha256')}.json") or {}).get("text", "") for side in SIDES}

    sources = {f"{side}_markdown": path.read_text(encoding="utf-8") for side, path in zip(SIDES, paths, strict=True) if hashlib.sha256(path.read_bytes()).hexdigest() == (report.get(side) or {}).get("source_sha256")}

    return jsonify({"report": report, **texts, **sources})


@app.get("/api/reviews")
def api_reviews():
    pair = pair_slug(*pair_paths(request.args))
    reviews = (read_json(REPORTS_DIR / pair / "report.json") or {}).get("recommendations")
    if not isinstance(reviews, dict) or not isinstance(reviews.get("findings"), dict):
        return jsonify({"error": f"No recommendations for {pair}"}), 404

    return jsonify(reviews)


@app.post("/api/reviews/stream")
def api_reviews_stream():
    return sse(run_reviews, *pair_paths(request.get_json(silent=True) or {}, "_path"))


@app.post("/api/analyze/stream")
def api_analyze_stream():
    body = request.get_json(silent=True) or {}
    paths = pair_paths(body, "_path")
    if _analysis["state"] == "running":
        return jsonify({"error": "An analysis is already in progress"}), 409

    return sse(run_document_analysis, *paths, body.get("label") or "Server run", bool(body.get("refresh")))


def serve(run_comparison, client, *, model: str = generation.MODEL, api_key: str | None = None, host="127.0.0.1", port=5000):
    global _server

    if _server is not None:
        _server.shutdown()

    _pipeline.update(run_comparison=run_comparison, client=client, model=model, api_key=api_key)
    _server = make_server(host, port, app, threaded=True)
    threading.Thread(target=_server.serve_forever, daemon=True).start()
    latest = max(saved_pairs(picker_payload()).values(), key=lambda pair: str(pair["created_at"]), default=None)
    query = f"?{urlencode({'reference': latest['reference_path'], 'input': latest['input_path']})}" if latest else ""
    print(f"Viewer running at http://{host}:{port}/{query}")
    print("Run server.stop() when you're done.")

    return _server


def stop():
    global _server

    if _server is not None:
        _server.shutdown()
        _server = None
