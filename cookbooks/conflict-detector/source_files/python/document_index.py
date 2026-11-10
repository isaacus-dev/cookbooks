import re
import json
import hashlib

from pathlib import Path

import numpy as np
import msgspec

from dotenv import load_dotenv

from normalize import normalize_text

PROJECT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_ROOT.parent
SAMPLES_DIR = REPO_ROOT / "samples"

MARKDOWN_SUFFIXES = (".md", ".markdown")

ENRICHER_MODEL = "kanon-2-enricher"

load_dotenv(PROJECT_ROOT / ".env")


class Clause(msgspec.Struct):
    doc: str
    seg_id: str
    type: str | None
    text: str
    start: int | None = None
    end: int | None = None
    parent: str | None = None
    category: str | None = None
    heading: str | None = None
    order: int | None = None
    definition: bool = False


def load_text(path) -> str:
    path = Path(path)
    text = path.read_text(encoding="utf-8")

    return normalize_text(text, markdown=path.suffix.lower() in MARKDOWN_SUFFIXES)


def enrich_document(client, text):
    return (
        client.enrichments.create(
            model=ENRICHER_MODEL,
            texts=text,
            overflow_strategy="auto",
        )
        .results[0]
        .document
    )


def document_sections(document):
    # The document's titled containers, saved with the index
    sections = []

    for seg in document.segments:
        if seg.kind != "container" or not seg.title:
            continue

        title = seg.title.decode(document.text).strip()

        if not title:
            continue

        sections.append(
            {
                "title": title,
                "level": seg.level,
                "start": seg.span.start,
                "end": seg.span.end,
            }
        )

    return sections


def own_title(document, seg):
    return seg.title.decode(document.text).strip() if seg.title else None


MARKDOWN_HEADING = re.compile(r"^#+\s+(.+)$", re.M)
HEADING_NUMBER = re.compile(r"^\d+(?:\\?\.\d+)*\\?\.?\s+")
DEFINITION_LEAD = re.compile(r"[\W\d_]*(?:(?:the|an?)\b[\W_]*)?", re.I)


def markdown_headings(text):
    found = []

    for match in MARKDOWN_HEADING.finditer(text):
        title = HEADING_NUMBER.sub("", match.group(1).replace("*", "")).strip()

        if title:
            found.append((match.start(), title))

    return found


def resolve_headings(document):
    markdown = markdown_headings(document.text)
    segments = {seg.id: seg for seg in document.segments}
    headings = {}

    for seg in document.segments:
        parent_id, heading = seg.parent, None

        while parent_id is not None and parent_id in segments:
            heading = own_title(document, segments[parent_id])

            if heading:
                break

            parent_id = segments[parent_id].parent

        # Title of the closest parent section that has one, else its own title, else the nearest markdown heading above
        headings[seg.id] = (
            heading
            or own_title(document, seg)
            or next((title for start, title in reversed(markdown) if start <= seg.span.start), None)
        )

    return headings


def opening(text):
    return text[DEFINITION_LEAD.match(text).end() :]


def defines_term(document, *, start, end):
    clause_opening = opening(document.text[start:end])

    # A definition opens with a term the enricher found, and that term is defined inside this clause
    return any(
        clause_opening.startswith(opening(term.name.decode(document.text)))
        and any(start <= pos < end for pos in (term.name.start, term.meaning.start))
        for term in document.terms
    )


def has_body(document, seg, *, start, end):
    # Spans that only label the segment: its type name ("Section"), code ("4.2") and title
    labels = [(span.start, span.end) for span in (seg.type_name, seg.code, seg.title) if span]

    # Markdown heading lines count as labels too
    pos = start

    for line in document.text[start:end].split("\n"):
        if line.lstrip().startswith("#"):
            labels.append((pos, pos + len(line)))

        pos += len(line) + 1

    # It has a body if any letter or digit sits outside every label
    return any(
        ch.isalnum() for n, ch in enumerate(document.text[start:end], start) if not any(a <= n < b for a, b in labels)
    )


def extract_clauses(doc_name, document):
    headings = resolve_headings(document)
    spans = {seg.id: seg.span for seg in document.segments}
    clauses = []

    for seg in document.segments:
        pieces, cut = [], seg.span.start

        # Cut the segment around its children's spans; each word belongs to one clause
        for child in sorted((spans[c] for c in seg.children), key=lambda span: span.start):
            pieces.append((cut, child.start))
            cut = max(cut, child.end)

        pieces.append((cut, seg.span.end))

        for n, (start, end) in enumerate(pieces):
            raw = document.text[start:end]
            clause_text = raw.strip()

            if not has_body(document, seg, start=start, end=end):
                continue

            # Offsets of the text once leading and trailing whitespace is trimmed
            clause_start, clause_end = start + len(raw) - len(raw.lstrip()), start + len(raw.rstrip())
            clauses.append(
                Clause(
                    doc=doc_name,
                    seg_id=seg.id if n == 0 else f"{seg.id}.{n}",
                    type=seg.type,
                    text=clause_text,
                    start=clause_start,
                    end=clause_end,
                    parent=seg.parent,
                    category=seg.category,
                    heading=headings.get(seg.id),
                    definition=defines_term(document, start=clause_start, end=clause_end),
                )
            )

    clauses.sort(key=lambda clause: clause.start)

    for order, clause in enumerate(clauses):
        clause.order = order

    return clauses


EMBEDDER_MODEL = "kanon-2-embedder"
EMBED_BATCH_SIZE = 96


def unit_normalize(rows) -> np.ndarray:
    vectors = np.array(rows, dtype=np.float32) if rows else np.zeros((0, 0), np.float32)

    if vectors.size == 0:
        return vectors

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)

    # Divide each vector by its length; an all-zero vector stays zero rather than dividing by zero
    return (vectors / np.where(norms == 0, 1, norms)).astype(np.float32)


def embed_propositions(client, texts, *, task="retrieval/document"):
    rows = []

    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        resp = client.embeddings.create(
            model=EMBEDDER_MODEL,
            texts=texts[i : i + EMBED_BATCH_SIZE],
            task=task,
        )
        rows.extend(e.embedding for e in resp.embeddings)

    return unit_normalize(rows)


RESULTS_DIR = PROJECT_ROOT / "results"
DOC_CACHE_DIR = RESULTS_DIR / "cache"
DOCUMENTS_DIR = RESULTS_DIR / "documents"
DOCUMENT_SCHEMA = "conflict-document/1"

PIPELINE_VERSION = 19


class DocumentIndex(msgspec.Struct):
    # One document's clauses (called propositions here), their embeddings and its cleaned text
    propositions: list
    embeddings: np.ndarray
    manifest: dict | None = None
    text: str | None = None
    sections: list | None = None


def read_index(index_dir: Path) -> DocumentIndex | None:
    index_dir = Path(index_dir)

    try:
        rows = json.loads((index_dir / "propositions.json").read_text(encoding="utf-8"))
        matrix = np.load(index_dir / "embeddings.npy")
        manifest = json.loads((index_dir / "manifest.json").read_text(encoding="utf-8"))
        text = (index_dir / "text.txt").read_text(encoding="utf-8")
        sections = json.loads((index_dir / "sections.json").read_text(encoding="utf-8"))

    except (OSError, ValueError):
        return None

    if matrix.shape[0] != len(rows):
        return None

    return DocumentIndex(
        propositions=[Clause(**{f.name: r.get(f.name) for f in msgspec.structs.fields(Clause)}) for r in rows],
        embeddings=matrix,
        manifest=manifest,
        text=text,
        sections=sections,
    )


def write_index(index, index_dir):
    index_dir = Path(index_dir)
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "manifest.json").write_text(json.dumps(index.manifest, indent=2), encoding="utf-8")
    (index_dir / "propositions.json").write_text(
        json.dumps([msgspec.structs.asdict(c) for c in index.propositions], indent=2),
        encoding="utf-8",
    )
    np.save(index_dir / "embeddings.npy", index.embeddings)
    (index_dir / "text.txt").write_text(index.text, encoding="utf-8")
    (index_dir / "sections.json").write_text(
        json.dumps(index.sections or [], indent=2),
        encoding="utf-8",
    )

    return index_dir


def document_identity(path, index, *, text=None) -> dict:
    path = Path(path)

    if text is None:
        text = index.text if index.text is not None else load_text(path)

    try:
        source = path.resolve().relative_to(REPO_ROOT).as_posix()

    except ValueError:
        source = str(path)

    return {
        "source": source,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "sections": index.sections or [],
    }


def document_artifact(path, index) -> dict:
    path = Path(path)
    text = load_text(path)
    assert index.text is None or index.text == text, f"{path.name}: clear results/cache"
    text = index.text if index.text is not None else text

    return {"schema": DOCUMENT_SCHEMA, **document_identity(path, index, text=text), "text": text}


def write_document_artifact(path, index, *, documents_dir=DOCUMENTS_DIR) -> Path:
    # The report only stores offsets, so the demo reads each document's text from here
    payload = document_artifact(path, index)
    dest = Path(documents_dir) / f"{payload['source_sha256']}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    return dest


def document_fingerprint(normalized_text):
    # Any change to the text, the pipeline version or a model re-indexes; delete results/cache/ to force it
    stamp = f"{PIPELINE_VERSION}|{ENRICHER_MODEL}|{EMBEDDER_MODEL}|{normalized_text}"

    return hashlib.sha256(stamp.encode("utf-8")).hexdigest()[:16]


def document_manifest(doc_name, path, entry):
    return {"doc_name": doc_name, "source_path": str(path), "files": {doc_name: entry}}


def index_document(client, path, *, use_cache=True) -> DocumentIndex:
    path = Path(path)
    text = load_text(path)
    cache_dir = DOC_CACHE_DIR / document_fingerprint(text)

    if use_cache:
        cached = rekey(read_index(cache_dir), path.name, path)

        if cached is not None:
            return cached

    document = enrich_document(client, text)
    propositions = extract_clauses(path.name, document)

    index = DocumentIndex(
        propositions=propositions,
        embeddings=embed_propositions(client, [p.text for p in propositions]),
        text=document.text,
        sections=document_sections(document),
        manifest=document_manifest(
            path.name, path, {"proposition_count": len(propositions), "clause_count": len(propositions)}
        ),
    )
    write_index(index, cache_dir)

    return index


def rekey(index, doc_name, path):
    if index is None or index.text is None:
        return None

    # A cached index may have been saved under another file name
    for clause in index.propositions:
        clause.doc = doc_name

    entry = next(iter((index.manifest or {}).get("files", {}).values()), {})
    index.manifest = document_manifest(doc_name, path, entry)

    return index
