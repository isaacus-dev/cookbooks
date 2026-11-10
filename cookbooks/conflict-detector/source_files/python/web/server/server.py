import os
import re
import sys
import json
import time
import queue
import shutil
import argparse
import threading
import subprocess
import unicodedata

from pathlib import Path
from datetime import UTC, datetime

import yaml

from flask import Flask, jsonify, request, Response, stream_with_context

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(WORKSPACE_ROOT))

from document_analysis import SCHEMA, REPORTS_DIR, read_json, pair_slug, comparison_dir_for
from document_index import REPO_ROOT, SAMPLES_DIR, DOCUMENTS_DIR

UPLOADS_DIR = SAMPLES_DIR / "uploads"

SIDES = ("reference", "input")
ORIGINS = (
    ("sample", "Samples", SAMPLES_DIR),
    ("uploaded", "Your uploads", UPLOADS_DIR),
)

SAMPLE_TITLES = {
    "08-disney-iger-employment-agreement-2022.md": "Disney / Robert A. Iger Employment Agreement (2022)",
    "09-disney-iger-amended-restated-employment-agreement-2011.md": "Disney / Robert A. Iger Amended and Restated Employment Agreement (2011)",
    "03-common-paper-cloud-service-agreement.md": "Common Paper Cloud Service Agreement",
    "04-mistral-ai-terms-of-use.md": "Mistral AI Terms of Use",
    "02-google-play-developer-distribution-agreement.md": "Google Play Developer Distribution Agreement",
    "05-boeing-tmssequoia-corporate-software-license-agreement.md": "Boeing / TMSSequoia Corporate Software License Agreement",
    "06-common-paper-mutual-nda.md": "Common Paper Mutual Non-Disclosure Agreement",
    "07-intel-cloudera-confidentiality-agreement.md": "Intel / Cloudera Confidentiality Agreement",
    "10-enron-frevert-executive-employment-agreement-1998.md": "Enron / Mark A. Frevert Executive Employment Agreement (1998)",
}

UPLOAD_SUFFIXES = (".md", ".markdown", ".txt")
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_FILES = 20
ANALYSIS_TIMEOUT_SECONDS = 60 * 60

app = Flask(__name__, static_folder=str(WORKSPACE_ROOT / "web" / "client"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES * MAX_UPLOAD_FILES

_analysis = {"state": "idle", "progress": None, "message": None, "run_id": None, "reference": None, "input": None, "label": None, "cached": None, "started_at": None}
_reviewing = threading.Lock()


def relative(path):
    return Path(path).resolve().relative_to(REPO_ROOT).as_posix()


def scan_document(path, origin, origin_label):
    match = re.match(r"---(.*?)---", path.read_text(encoding="utf-8", errors="replace")[:4096], re.S)
    try:
        fm = yaml.safe_load(match[1]) if match else None

    except yaml.YAMLError:
        fm = None

    title = fm.get("title") if isinstance(fm, dict) else None

    return {
        "path": relative(path),
        "name": path.name,
        "origin": origin,
        "origin_label": origin_label,
        "title": title or SAMPLE_TITLES.get(path.name) or path.stem.replace("-", " ").title(),
    }


def picker_payload():
    documents = [
        scan_document(p, origin, label)
        for origin, label, root in ORIGINS
        for p in sorted(root.rglob("*"))
        if (root != SAMPLES_DIR or p.parent == SAMPLES_DIR)
        and p.is_file() and p.suffix.lower() in (".md", ".markdown") and p.name.lower() not in ("theme.yaml", "readme.md")
    ]

    return {"upload": {"accept": list(UPLOAD_SUFFIXES), "max_bytes": MAX_UPLOAD_BYTES}, **{side: {"documents": documents} for side in SIDES}}


def resolve_side_path(raw, _side, what):
    if not raw:
        raise ValueError(f"{what} is required")

    roots = [root.resolve() for *_, root in ORIGINS]
    options = [REPO_ROOT / raw] + [root / raw for root in roots]
    resolved = next((option for option in options if option.is_file()), options[0]).resolve()
    if not any(resolved.is_relative_to(root) for root in roots):
        raise ValueError(f"{what} must be inside {' or '.join(relative(root) for root in roots)}")

    if not resolved.is_file():
        raise ValueError(f"{what} not found: {raw}")

    return resolved


def pair_paths(args, suffix=""):
    return [resolve_side_path(args.get(side + suffix), side, f"{side.title()} document") for side in SIDES]


def saved_report(folder):
    report = read_json(folder / "report.json")
    valid = isinstance(report, dict) and report.get("schema") == SCHEMA and isinstance(report.get("summary"), dict)

    return report if valid else None


def committed(folder, since=0):
    try:
        return (folder / "params.json").stat().st_mtime >= since and saved_report(folder) is not None

    except OSError:
        return False


def run_script(name, reference_path, input_path, *extra):
    return subprocess.Popen(
        [sys.executable, str(WORKSPACE_ROOT / name), "--reference", str(reference_path), "--input", str(input_path), *extra],
        cwd=WORKSPACE_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )


def relay(proc, emit, suffix="", **extra):
    lines = []
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            lines.append(line)

        if line.startswith("STAGE: "):
            emit({"type": "status", "message": line[7:] + suffix})

        elif (match := re.search(r"(\d+)/(\d+)", line)) and int(match[2]) > 0:
            emit({"type": "progress", "done": int(match[1]), "total": int(match[2]), **extra})

    return "\n".join(lines[-8:]).strip()


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
        dest = comparison_dir_for(reference_path, input_path)
        emit({"type": "started", "reference": reference_name, "input": input_name})
        cached = not refresh and committed(dest)
        if cached:
            record({"type": "status", "message": "Reused this pair's cached run"})

        else:
            record({"type": "status", "message": f"Comparing {input_name} against {reference_name}…"})
            existed_before = dest.exists()
            started = time.time()
            deadline = time.monotonic() + ANALYSIS_TIMEOUT_SECONDS
            proc = run_script("document_analysis.py", reference_path, input_path, "--label", label, *(["--no-cache"] if refresh else []))
            tail = []
            reader = threading.Thread(target=lambda: tail.append(relay(proc, record, "…", document=input_name)), daemon=True)
            reader.start()
            try:
                while True:
                    if committed(dest, started):
                        proc.kill()
                        break

                    try:
                        rc = proc.wait(timeout=0.5)

                    except subprocess.TimeoutExpired:
                        if time.monotonic() < deadline:
                            continue

                        proc.kill()
                        raise RuntimeError(f"document_analysis.py exceeded {ANALYSIS_TIMEOUT_SECONDS}s and was stopped") from None

                    reader.join(timeout=5)
                    if rc != 0:
                        raise RuntimeError("".join(tail) or "document_analysis.py failed")

                    if not committed(dest):
                        raise RuntimeError(f"Analysis wrote no readable run to {relative(dest)}")

                    break

            except Exception:
                if not existed_before:
                    shutil.rmtree(dest, ignore_errors=True)

                raise

            record({"type": "status", "message": "Summarizing and recommending…"})
            proc = run_script("generation.py", reference_path, input_path)
            output = proc.communicate()[0]
            if proc.returncode != 0:
                print(f"generation.py failed; the run keeps summaries: null\n{output[-2000:]}", file=sys.stderr)

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
        proc = run_script("generation.py", reference_path, input_path)
        tail = relay(proc, emit)
        if proc.wait() != 0:
            raise RuntimeError(tail or "generation.py failed")

    finally:
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
    return app.send_static_file("index.html")


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
        name = storage.filename
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


@app.get("/api/catalog")
def api_catalog():
    payload = picker_payload()
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

    return jsonify({**payload, "pairs": pairs})


@app.get("/api/run")
def api_run():
    pair = pair_slug(*pair_paths(request.args))
    report = saved_report(REPORTS_DIR / pair)
    if report is None:
        return jsonify({"error": f"No cached run for {pair}"}), 404

    texts = {f"{side}_text": (read_json(DOCUMENTS_DIR / f"{(report.get(side) or {}).get('source_sha256')}.json") or {}).get("text", "") for side in SIDES}

    return jsonify({"report": report, **texts})


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pairwise document comparison server")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    app.run(debug=True, host=args.host, port=args.port, use_reloader=False)
