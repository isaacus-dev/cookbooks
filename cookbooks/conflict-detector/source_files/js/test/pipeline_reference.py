import re
import ast
import sys
import json

from types import SimpleNamespace
from pathlib import Path
from functools import partial

import numpy as np
import msgspec

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import document_index as di
import document_analysis as da


class Span(SimpleNamespace):
    def decode(self, text):
        return text[self.start : self.end]


def record(value):
    if isinstance(value, list):
        return [record(item) for item in value]

    if isinstance(value, dict):
        return Span(**{key: record(item) for key, item in value.items()})

    return value


def score(query, text, kind):
    # The fixture responses depend on the complete query, including non-BMP text.
    if kind == "classify" and query == da.FILTER_QUERY:
        return 0.9 if "Editorial" in text or text.startswith("The ") else 0.1

    total = sum(ord(char) for char in f"{kind}|{query}|{text}")

    if kind == "rerank" and query == da.EMPTY_QUERY:
        return 0.001 if "Payment" in text else 0.8

    if kind == "classify" and query == da.MONEY_STATEMENT:
        return 0.99 if "Payment" in text else 0.1

    return 0.01 + (total % 91) / 100_000


def classify(**kwargs):
    return SimpleNamespace(
        classifications=[
            SimpleNamespace(index=n, score=score(kwargs["query"], text, "classify"))
            for n, text in reversed(list(enumerate(kwargs["texts"])))
        ]
    )


def rerank(**kwargs):
    return SimpleNamespace(
        results=[
            SimpleNamespace(index=n, score=score(kwargs["query"], text, "rerank"))
            for n, text in reversed(list(enumerate(kwargs["texts"])))
        ]
    )


def embed(**kwargs):
    assert kwargs["model"] == di.EMBEDDER_MODEL
    assert kwargs["task"] == "retrieval/document"
    assert len(kwargs["texts"]) <= di.EMBED_BATCH_SIZE

    return SimpleNamespace(
        embeddings=[SimpleNamespace(embedding=[len(text), sum(map(ord, text)) % 17, 1]) for text in kwargs["texts"]]
    )


def enrich(*, document, **kwargs):
    assert kwargs == {
        "model": di.ENRICHER_MODEL,
        "texts": document["text"],
        "overflow_strategy": "auto",
    }

    return SimpleNamespace(results=[SimpleNamespace(document=record(document))])


def run(data):
    if data.get("read_run"):
        return da.saved_report_if_current(data["read_run"], data["paths"][1], data["paths"][0])

    client = SimpleNamespace(
        classifications=SimpleNamespace(universal=SimpleNamespace(create=classify)),
        rerankings=SimpleNamespace(create=rerank),
        embeddings=SimpleNamespace(create=embed),
        enrichments=SimpleNamespace(create=partial(enrich, document=data["documents"][0])),
    )
    enriched = di.enrich_document(client, data["documents"][0]["text"])
    embedded = di.embed_propositions(client, data["embedding_texts"])

    documents = [record(document) for document in data["documents"]]
    clauses = [di.extract_clauses(f"document-{n}.md", doc) for n, doc in enumerate(documents)]
    indexes = [
        di.DocumentIndex(
            propositions=rows,
            embeddings=di.unit_normalize(vectors),
            text=doc.text,
            sections=di.document_sections(doc),
        )
        for rows, vectors, doc in zip(clauses, data["vectors"], documents, strict=True)
    ]
    input_doc, reference = indexes
    filtered = [da.non_operative(client, index) for index in indexes]
    sim = da.pair_matrix(input_doc, reference)
    shortlist = da.shortlist_pairs(da.mask_non_operative(sim, *filtered), min_relevance=0.5, top_k=3)

    scored = da.score_pairs(client, input_doc, reference, shortlist=shortlist)
    deviating, input_status, reference_status = da.partition(input_doc, reference, scored)
    rows = da.roll_up_deviations(deviating, input_doc, reference)
    gaps_reference = da.roll_up_gaps(reference, reference_status, other=input_doc, filtered=filtered[1])
    gaps_input = da.roll_up_gaps(input_doc, input_status, other=reference, filtered=filtered[0])
    pairs = da.scored_pairs_rows(input_doc, reference, scored, deviating={(i, j) for i, j, _ in deviating})

    report = da.build_report(
        reference=reference,
        input_doc=input_doc,
        reference_path=Path(data["paths"][1]),
        input_path=Path(data["paths"][0]),
        deviation_rows=rows,
        gaps_reference=gaps_reference,
        gaps_input=gaps_input,
        input_status=input_status,
        reference_status=reference_status,
        input_filtered=filtered[0],
        reference_filtered=filtered[1],
        pairs=pairs,
    )
    da.write_analysis_run(
        report,
        reference=reference,
        input_doc=input_doc,
        reference_path=Path(data["paths"][1]),
        input_path=Path(data["paths"][0]),
        run_dir=Path(data["python_run_dir"]),
        documents_dir=Path(data["documents_dir"]),
    )
    for index, folder in zip(indexes, data["cache_dirs"], strict=True):
        di.write_index(index, folder)

    scores = [da.PairScore(**item) for item in data["scores"]]

    return {
        "structure": {
            name: {
                "regions": re.findall(r"^# region (.+)$", Path(module.__file__).read_text(), re.M),
                "functions": [
                    node.name
                    for node in ast.parse(Path(module.__file__).read_text()).body
                    if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                ],
            }
            for name, module in (("document_index", di), ("document_analysis", da))
        },
        "enriched": enriched.text,
        "embedded": embedded.tolist(),
        "extractions": [
            [msgspec.structs.asdict(c) for c in di.extract_clauses("edge.md", record(doc))]
            for doc in data["extractions"]
        ],
        "clauses": [[msgspec.structs.asdict(c) for c in rows] for rows in clauses],
        "sections": [index.sections for index in indexes],
        "embeddings": [index.embeddings.tolist() for index in indexes],
        "filtered": [mask.tolist() for mask in filtered],
        "similarity": sim.tolist(),
        "shortlist": list(shortlist.items()),
        "scored": [[f"{i}:{j}", msgspec.structs.asdict(sc)] for (i, j), sc in scored.items()],
        "report": report,
        "params": da.analysis_params(),
        "scores": [[sc.same_matter, sc.materiality, sc.differs, sc.conflict] for sc in scores],
        "shortlists": [
            list(da.shortlist_pairs(np.array(matrix), min_relevance=0.5, top_k=3).items())
            for matrix in data["matrices"]
        ],
        "cached": [di.read_index(folder).embeddings.tolist() for folder in data["js_cache_dirs"]],
    }


print(json.dumps(run(json.loads(Path(sys.argv[1]).read_text()))))
