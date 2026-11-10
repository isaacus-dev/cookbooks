import os
import re
import sys
import json
import math
import shutil
import hashlib
import argparse

from pathlib import Path
from datetime import UTC, datetime
from functools import partial
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import msgspec

from isaacus import Isaacus

from document_index import (
    Clause,
    load_text,
    RESULTS_DIR,
    SAMPLES_DIR,
    PROJECT_ROOT,
    DocumentIndex,
    DOCUMENTS_DIR,
    EMBEDDER_MODEL,
    ENRICHER_MODEL,
    index_document,
    PIPELINE_VERSION,
    document_identity,
    write_document_artifact,
)

CLASSIFIER_MODEL = "kanon-universal-classifier"

SHORTLIST_MIN_RELEVANCE = 0.5
SHORTLIST_TOP_K = 3

STRUCTURAL_CATEGORIES = ("front_matter", "back_matter", "annotation")

FILTER_QUERY = "{This is a footnote, citation, editorial note, heading or signature, not a contractual provision.}"
FILTER_THRESHOLD = 0.5


def pair_matrix(input_doc: DocumentIndex, reference: DocumentIndex) -> np.ndarray:
    if input_doc.embeddings.size == 0 or reference.embeddings.size == 0:
        return np.zeros((len(input_doc.propositions), len(reference.propositions)), np.float32)

    return input_doc.embeddings @ reference.embeddings.T


def non_operative(client, index: DocumentIndex) -> np.ndarray:
    scores = classify(client, FILTER_QUERY, [flatten(c.text) for c in index.propositions], is_iql=True)

    return np.array(
        [
            c.category in STRUCTURAL_CATEGORIES or (not c.definition and score >= FILTER_THRESHOLD)
            for c, score in zip(index.propositions, scores, strict=True)
        ],
        dtype=bool,
    )


def mask_non_operative(sim: np.ndarray, inc: np.ndarray, ref: np.ndarray) -> np.ndarray:
    masked = sim.copy()

    # A filtered clause scores -1 with everything, so it can't be shortlisted
    masked[inc[:, None] | ref[None, :]] = -1.0

    return masked


def shortlist_pairs(sim: np.ndarray, *, min_relevance: float, top_k: int) -> dict[int, list[tuple[int, float]]]:
    if sim.size == 0:
        return {}

    # Rank of each pair among its input clause's matches, and among its reference clause's (0 = closest)
    row_rank = np.argsort(np.argsort(-sim, axis=1, kind="stable"), axis=1)
    col_rank = np.argsort(np.argsort(-sim, axis=0, kind="stable"), axis=0)

    # Keep a pair that's similar enough and in the top k for either clause
    keep = (sim >= min_relevance) & ((row_rank < top_k) | (col_rank < top_k))

    shortlist: dict[int, list[tuple[int, float]]] = defaultdict(list)

    for i, j in zip(*np.nonzero(keep), strict=True):
        shortlist[int(i)].append((int(j), float(sim[i, j])))

    for row in shortlist.values():
        row.sort(key=lambda entry: -entry[1])

    return dict(shortlist)


def flatten(text: str) -> str:
    return " ".join(text.split())


def span(clause: Clause) -> dict | None:
    if clause.start is None or clause.end is None:
        return None

    return {"start": clause.start, "end": clause.end}


def clause_ref(clause: Clause) -> dict:
    return {"seg_id": clause.seg_id, "text": flatten(clause.text), "span": span(clause)}


CLASSIFY_MAX_PARALLEL_REQUESTS = 6
CLASSIFY_BATCH_SIZE = 50


def batched(score, texts: list[str]) -> list[float]:
    batches = [texts[n : n + CLASSIFY_BATCH_SIZE] for n in range(0, len(texts), CLASSIFY_BATCH_SIZE)]

    with ThreadPoolExecutor(max_workers=CLASSIFY_MAX_PARALLEL_REQUESTS) as pool:
        return [s for scores in pool.map(score, batches) for s in scores]


def classify_batch(client, batch: list[str], *, query: str, is_iql: bool) -> list[float]:
    resp = client.classifications.universal.create(
        model=CLASSIFIER_MODEL, query=query, texts=batch, is_iql=is_iql, scoring_method="auto"
    )

    return [c.score for c in sorted(resp.classifications, key=lambda c: c.index)]


def classify(client, query: str, texts: list[str], *, is_iql: bool = False) -> list[float]:
    return batched(partial(classify_batch, client, query=query, is_iql=is_iql), texts)


RERANKER_MODEL = "kanon-2-reranker"

EMPTY_QUERY = "routine boilerplate, a recital, a preamble, a heading, a signature block, an address or a definition"
CARE_STATEMENT = "A party would not care whether this clause or the following clause applied: {clause}"
AGREE_QUERY = "A lawyer would compare this clause with the following clause: {clause}"
MONEY_STATEMENT = "This states an amount of money, a percentage or a cap."
CLASSIFY_QUERY_MAX_CHARS = 2000
MATCH_TEMPERATURE = 0.06
SAME_SLOPE = 2.049
SAME_BIAS = 3.058

EMPTY_WEIGHT = -4.0
CARE_WEIGHT = -1.0
AGREE_WEIGHT = -1.0
MONEY_WEIGHT = 1.0
DIFFERS_SLOPE = 0.526
DIFFERS_BIAS = -12.312
CONFLICT_SAME_SLOPE = 0.576
CONFLICT_DIFFERS_SLOPE = 0.707
CONFLICT_BIAS = 1.663


def rerank_batch(client, batch: list[str], *, query: str) -> list[float]:
    resp = client.rerankings.create(model=RERANKER_MODEL, query=query, texts=batch)

    return [r.score for r in sorted(resp.results, key=lambda r: r.index)]


def rerank(client, query: str, texts: list[str]) -> list[float]:
    return batched(partial(rerank_batch, client, query=query), texts)


def logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)

    return math.log(p / (1 - p))


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def log_sigmoid(x: float) -> float:
    # log(sigmoid(x)), without rounding tiny probabilities to zero
    return -float(np.logaddexp(0.0, -x))


def mean(scores: dict, a, b) -> float:
    return (scores[a] + scores[b]) / 2


def score_query(b: str, *, texts: list[str], score, template: str, max_chars: int | None) -> dict:
    # Ask the model about clause b once, against every clause it's paired with
    return {(a, b): s for a, s in zip(texts, score(template.format(clause=b[:max_chars]), texts), strict=True)}


def pairwise(score, template: str, pairs: list[tuple[str, str]], *, max_chars: int | None = None) -> dict:
    by_query: dict[str, list[str]] = defaultdict(list)

    # Group pairs by their second clause, so each clause goes to the model once
    for a, b in dict.fromkeys(pairs):
        by_query[b].append(a)

    out = {}

    with ThreadPoolExecutor(max_workers=CLASSIFY_MAX_PARALLEL_REQUESTS) as pool:
        jobs = [
            pool.submit(score_query, b, texts=texts, score=score, template=template, max_chars=max_chars)
            for b, texts in by_query.items()
        ]

        for job in jobs:
            out.update(job.result())

    return out


class PairScore(msgspec.Struct):
    relevance: float
    match: float
    empty: float
    care: float
    agree: float
    money: float

    @property
    def same_matter(self) -> float:
        return sigmoid(SAME_SLOPE * self.match + SAME_BIAS)

    @property
    def materiality(self) -> float:
        return (
            EMPTY_WEIGHT * logit(self.empty)
            + CARE_WEIGHT * logit(self.care)
            + AGREE_WEIGHT * logit(self.agree)
            + MONEY_WEIGHT * logit(self.money)
        )

    @property
    def differs(self) -> float:
        return sigmoid(DIFFERS_SLOPE * self.materiality + DIFFERS_BIAS)

    @property
    def conflict(self) -> float:
        return sigmoid(
            CONFLICT_SAME_SLOPE * log_sigmoid(SAME_SLOPE * self.match + SAME_BIAS)
            + CONFLICT_DIFFERS_SLOPE * log_sigmoid(DIFFERS_SLOPE * self.materiality + DIFFERS_BIAS)
            + CONFLICT_BIAS
        )


def match_matrix(sim: np.ndarray) -> np.ndarray:
    logits = sim / MATCH_TEMPERATURE
    row = logits - np.logaddexp.reduce(logits, axis=1, keepdims=True)
    col = logits - np.logaddexp.reduce(logits, axis=0, keepdims=True)

    return (row + col) / 2


def score_pairs(
    client,
    input_doc: DocumentIndex,
    reference: DocumentIndex,
    *,
    shortlist: dict[int, list[tuple[int, float]]],
) -> dict[tuple[int, int], PairScore]:
    match = match_matrix(pair_matrix(input_doc, reference))
    texts = {
        (i, j): (flatten(input_doc.propositions[i].text), flatten(reference.propositions[j].text))
        for i, row in shortlist.items()
        for j, _ in row
    }
    unique = list(dict.fromkeys(t for pair in texts.values() for t in pair))
    both_ways = [p for a, b in texts.values() for p in ((a, b), (b, a))]

    empty = dict(zip(unique, rerank(client, EMPTY_QUERY, unique), strict=True))
    money = dict(zip(unique, classify(client, MONEY_STATEMENT, unique), strict=True))
    care = pairwise(partial(classify, client), CARE_STATEMENT, both_ways, max_chars=CLASSIFY_QUERY_MAX_CHARS)
    agree = pairwise(partial(rerank, client), AGREE_QUERY, both_ways)

    return {
        (i, j): PairScore(
            relevance=relevance,
            match=float(match[i, j]),
            empty=mean(empty, *texts[(i, j)]),
            money=mean(money, *texts[(i, j)]),
            care=mean(care, texts[(i, j)], texts[(i, j)][::-1]),
            agree=mean(agree, texts[(i, j)], texts[(i, j)][::-1]),
        )
        for i, candidates in shortlist.items()
        for j, relevance in candidates
    }


SAME_THRESHOLD = 0.3

CONFLICT_THRESHOLD = 0.728


def status(pairs: list[tuple[int, PairScore]], *, deviating: bool) -> dict:
    best = max(pairs, key=lambda e: e[1].relevance, default=None)

    return {
        "status": "deviation" if deviating else "covered" if pairs else "gap",
        "best_relevance": best[1].relevance if best else None,
        "nearest_index": best[0] if best else None,
    }


def side_status(index: DocumentIndex, pairs, deviating: set[int]) -> dict[int, dict]:
    return {n: status(pairs.get(n, []), deviating=n in deviating) for n in range(len(index.propositions))}


def partition(input_doc: DocumentIndex, reference: DocumentIndex, scored: dict[tuple[int, int], PairScore]):
    closest: dict[int, dict[int, tuple[tuple[int, int], PairScore]]] = {0: {}, 1: {}}

    # For each clause on each side, keep its best match that's about the same matter
    for pair, sc in scored.items():
        for side, best in closest.items():
            if sc.same_matter >= SAME_THRESHOLD and (pair[side] not in best or sc.match > best[pair[side]][1].match):
                best[pair[side]] = (pair, sc)

    # Both sides' picks together; a pair both clauses picked appears once
    selected = dict(entry for best in closest.values() for entry in best.values())

    # A picked pair is a deviation when its P(conflict) clears the threshold
    deviating_pairs = [(i, j, sc) for (i, j), sc in selected.items() if sc.conflict >= CONFLICT_THRESHOLD]

    inc_pairs: dict[int, list[tuple[int, PairScore]]] = defaultdict(list)
    ref_pairs: dict[int, list[tuple[int, PairScore]]] = defaultdict(list)

    for (i, j), score in scored.items():
        if score.same_matter >= SAME_THRESHOLD:
            inc_pairs[i].append((j, score))
            ref_pairs[j].append((i, score))

    return (
        deviating_pairs,
        side_status(input_doc, inc_pairs, {i for i, _, _ in deviating_pairs}),
        side_status(reference, ref_pairs, {j for _, j, _ in deviating_pairs}),
    )


def clause_row(clause: Clause) -> dict:
    return {
        "id": None,
        "seg_id": clause.seg_id,
        "heading": clause.heading,
        "text": flatten(clause.text),
        "span": span(clause),
        "order": clause.order,
        "category": clause.category,
    }


def numbered(rows: list[dict], sort_key) -> list[dict]:
    # Number rows in document order, so the report reads top to bottom like the documents
    rows.sort(key=sort_key)

    for n, row in enumerate(rows, start=1):
        row["id"] = n

    return rows


def roll_up_deviations(deviating_pairs, input_doc: DocumentIndex, reference: DocumentIndex) -> list[dict]:
    by_input: dict[int, list[tuple[int, PairScore]]] = defaultdict(list)

    for i, j, score in deviating_pairs:
        by_input[i].append((j, score))

    rows = []

    for i, pairs in by_input.items():
        pairs.sort(key=lambda e: reference.propositions[e[0]].order or 0)
        rows.append(
            {
                **clause_row(input_doc.propositions[i]),
                "relevance": pairs[0][1].relevance,
                "match_count": len(pairs),
                "matches": [
                    {
                        "input": clause_ref(input_doc.propositions[i]),
                        "reference": {
                            **clause_ref(reference.propositions[j]),
                            "clause_text": flatten(reference.propositions[j].text),
                        },
                        "relevance": score.relevance,
                    }
                    for j, score in pairs
                ],
            }
        )

    return numbered(rows, lambda r: r["order"] or 0)


def roll_up_gaps(
    index: DocumentIndex, status: dict[int, dict], *, other: DocumentIndex, filtered: np.ndarray
) -> list[dict]:
    rows = []

    for i, clause in enumerate(index.propositions):
        info = status[i]

        if filtered[i] or info["status"] != "gap" or clause.definition:
            continue

        near = info["nearest_index"]
        rows.append(
            {
                **clause_row(clause),
                "propositions": {"total": 1, "matched_count": 0, "uncovered_count": 1},
                "gap_score": 1.0 - (info["best_relevance"] or 0.0),
                "uncovered_propositions": [
                    {
                        **clause_ref(clause),
                        **{k: info[k] for k in ("status", "best_relevance")},
                        "nearest": clause_ref(other.propositions[near]) if near is not None else None,
                    }
                ],
            }
        )

    return numbered(rows, lambda r: r["order"] or 0)


REPORTS_DIR = RESULTS_DIR / "reports"

SCHEMA = "doc-compare/2"


def coverage_counts(status: dict[int, dict], filtered: np.ndarray) -> dict:
    counts = {"total": len(status), "covered": 0, "deviation": 0, "gap": 0, "filtered": int(filtered.sum())}

    for n, row in status.items():
        if not filtered[n]:
            counts[row["status"]] += 1

    return counts


def document_summary(index: DocumentIndex, path: Path) -> dict:
    return {
        "name": Path(path).name,
        **document_identity(path, index),
        "propositions": len(index.propositions),
    }


def scored_pairs_rows(input_doc, reference, scored, *, deviating) -> list[dict]:
    rows = []

    for (i, j), score in scored.items():
        inc, ref = input_doc.propositions[i], reference.propositions[j]
        rows.append(
            {
                "input_seg": inc.seg_id,
                "input": flatten(inc.text),
                "reference_seg": ref.seg_id,
                "reference": flatten(ref.text),
                "relevance": score.relevance,
                "same_matter": score.same_matter,
                "differs": score.differs,
                "conflict": score.conflict,
                "deviating": (i, j) in deviating,
            }
        )

    rows.sort(key=lambda row: -row["relevance"])

    return rows


def build_report(
    *,
    reference,
    input_doc,
    reference_path,
    input_path,
    deviation_rows,
    gaps_reference,
    gaps_input,
    input_status,
    reference_status,
    input_filtered,
    reference_filtered,
    pairs,
) -> dict:
    return {
        "schema": SCHEMA,
        "reference": document_summary(reference, reference_path),
        "input": document_summary(input_doc, input_path),
        "summary": {
            "deviation_rows": len(deviation_rows),
            "deviations": sum(row["match_count"] for row in deviation_rows),
            "shortlisted_pairs": len(pairs),
            "gaps_reference": len(gaps_reference),
            "gaps_input": len(gaps_input),
            "reference_coverage": coverage_counts(reference_status, reference_filtered),
            "input_coverage": coverage_counts(input_status, input_filtered),
        },
        "summaries": None,
        "recommendations": None,
        "deviations": deviation_rows,
        "gaps_reference": gaps_reference,
        "gaps_input": gaps_input,
        "pairs": pairs,
    }


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "document"


def pair_slug(reference_path, input_path) -> str:
    return f"{slug(Path(reference_path).stem)}__{slug(Path(input_path).stem)}"


def analysis_params() -> dict:
    return {
        "schema": SCHEMA,
        "pipeline_version": PIPELINE_VERSION,
        "enricher_model": ENRICHER_MODEL,
        "embedder_model": EMBEDDER_MODEL,
        "classifier_model": CLASSIFIER_MODEL,
        "shortlist_min_relevance": SHORTLIST_MIN_RELEVANCE,
        "shortlist_top_k": SHORTLIST_TOP_K,
        "filter_query": FILTER_QUERY,
        "filter_threshold": FILTER_THRESHOLD,
        "reranker_model": RERANKER_MODEL,
        "empty_query": EMPTY_QUERY,
        "care_statement": CARE_STATEMENT,
        "agree_query": AGREE_QUERY,
        "money_statement": MONEY_STATEMENT,
        "classify_query_max_chars": CLASSIFY_QUERY_MAX_CHARS,
        "match_temperature": MATCH_TEMPERATURE,
        "same_slope": SAME_SLOPE,
        "same_bias": SAME_BIAS,
        "same_threshold": SAME_THRESHOLD,
        "materiality_weights": [EMPTY_WEIGHT, CARE_WEIGHT, AGREE_WEIGHT, MONEY_WEIGHT],
        "differs_slope": DIFFERS_SLOPE,
        "differs_bias": DIFFERS_BIAS,
        "conflict_slopes": [CONFLICT_SAME_SLOPE, CONFLICT_DIFFERS_SLOPE],
        "conflict_bias": CONFLICT_BIAS,
        "conflict_threshold": CONFLICT_THRESHOLD,
        "structural_categories": list(STRUCTURAL_CATEGORIES),
    }


def comparison_dir_for(reference_path, input_path, *, runs_dir=REPORTS_DIR) -> Path:
    return Path(runs_dir) / pair_slug(reference_path, input_path)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))

    except (OSError, ValueError):
        return None


def saved_report_if_current(comparison_dir, reference_path, input_path) -> dict | None:
    report = read_json(Path(comparison_dir) / "report.json")
    saved = read_json(Path(comparison_dir) / "params.json")

    if report is None or saved is None:
        return None

    current = analysis_params()

    if {k: saved.get(k) for k in current} != current:
        return None

    for side, path in (("reference", reference_path), ("input", input_path)):
        text = load_text(path).encode("utf-8")

        if report.get(side, {}).get("text_sha256") != hashlib.sha256(text).hexdigest():
            return None

    return report


def write_analysis_run(
    report,
    *,
    reference: DocumentIndex,
    input_doc: DocumentIndex,
    reference_path: Path,
    input_path: Path,
    run_dir: Path,
    label=None,
    documents_dir=DOCUMENTS_DIR,
) -> Path:
    dest = Path(run_dir)

    if dest.exists():
        shutil.rmtree(dest)

    dest.mkdir(parents=True)

    params = {
        **analysis_params(),
        "slug": dest.name,
        "label": label,
        "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }

    for name, payload in (
        ("report", {k: v for k, v in report.items() if k != "pairs"}),
        ("pairs", report.get("pairs") or []),
        ("params", params),
    ):
        (dest / f"{name}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    write_document_artifact(reference_path, reference, documents_dir=documents_dir)
    write_document_artifact(input_path, input_doc, documents_dir=documents_dir)

    return dest


def run_comparison(client, reference_path, input_path, *, use_cache: bool = True, label: str | None = None) -> dict:
    reference_path, input_path = Path(reference_path), Path(input_path)
    dest = comparison_dir_for(reference_path, input_path)

    if use_cache and (report := saved_report_if_current(dest, reference_path, input_path)) is not None:
        return report

    print("STAGE: Reading documents")
    reference = index_document(client, reference_path, use_cache=use_cache)
    input_doc = index_document(client, input_path, use_cache=use_cache)

    print("STAGE: Filtering")
    input_filtered, reference_filtered = non_operative(client, input_doc), non_operative(client, reference)

    print("STAGE: Matching")
    shortlist = shortlist_pairs(
        mask_non_operative(pair_matrix(input_doc, reference), input_filtered, reference_filtered),
        min_relevance=SHORTLIST_MIN_RELEVANCE,
        top_k=SHORTLIST_TOP_K,
    )

    print("STAGE: Classifying")
    scored = score_pairs(client, input_doc, reference, shortlist=shortlist)

    print("STAGE: Comparing")
    deviating_pairs, input_status, reference_status = partition(input_doc, reference, scored)

    deviation_rows = roll_up_deviations(deviating_pairs, input_doc, reference)
    gaps_reference = roll_up_gaps(reference, reference_status, other=input_doc, filtered=reference_filtered)
    gaps_input = roll_up_gaps(input_doc, input_status, other=reference, filtered=input_filtered)

    print("STAGE: Assembling report")
    report = build_report(
        reference=reference,
        input_doc=input_doc,
        reference_path=reference_path,
        input_path=input_path,
        deviation_rows=deviation_rows,
        gaps_reference=gaps_reference,
        gaps_input=gaps_input,
        input_status=input_status,
        reference_status=reference_status,
        input_filtered=input_filtered,
        reference_filtered=reference_filtered,
        pairs=scored_pairs_rows(input_doc, reference, scored, deviating={(i, j) for i, j, _ in deviating_pairs}),
    )

    print("STAGE: Saving results")
    write_analysis_run(
        report,
        reference=reference,
        input_doc=input_doc,
        reference_path=reference_path,
        input_path=input_path,
        run_dir=dest,
        label=label,
    )

    return report


def resolve_doc_arg(raw: str) -> Path:
    path = Path(raw)

    if path.is_absolute():
        return path.resolve()

    roots = (Path.cwd(), PROJECT_ROOT, SAMPLES_DIR)

    return next((r / path for r in roots if (r / path).is_file()), PROJECT_ROOT / path).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare one reference document against one input document.")
    add = parser.add_argument
    add("--reference", required=True, help="Reference document path")
    add("--input", required=True, help="Input document path")
    add("--label", default=None, help="Optional label stored in params.json")
    add(
        "--no-cache",
        action="store_true",
        help="Re-run the comparison and re-index both documents, refreshing the caches rather than reading them.",
    )

    return parser.parse_args()


def document_paths_from_args(args) -> tuple[Path, Path]:
    paths = tuple(resolve_doc_arg(a) for a in (args.reference, args.input))

    for path in paths:
        if not path.is_file():
            sys.exit(f"Document not found: {path}")

    return paths


def main():
    args = parse_args()
    reference_path, input_path = document_paths_from_args(args)
    client = Isaacus(api_key=os.getenv("ISAACUS_API_KEY"))
    run_comparison(client, reference_path, input_path, use_cache=not args.no_cache, label=args.label)


if __name__ == "__main__":
    main()
