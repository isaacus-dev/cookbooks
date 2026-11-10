# Isaacus Legal Document Conflict Detector Cookbook

The Isaacus Python/JavaScript cookbook in this repo shows how to find conflicts between two legal documents. Findings consist of:

1. Deviation: two provisions that cover the same topic but don’t have the same legal effect.
2. Gap: a provision in one document with no agreement or difference in the other document.

## Getting started

- [`conflict_detector_python.ipynb`](conflict_detector_python.ipynb): the tutorial in Python
- [`conflict_detector_js.ipynb`](conflict_detector_js.ipynb): the tutorial in JavaScript (Deno kernel)

The general process is as follows:

1. Documents are prepared beforehand, i.e. cleaned and then normalized.
2. The documents are split into segments with [Kanon 2 Enricher](https://isaacus.com/docs/models/introduction#enrichment).
3. The segments are embedded with [Kanon 2 Embedder](https://isaacus.com/docs/models/introduction#embedding).
4. The segments get filtered with [Kanon Universal Classifier](https://isaacus.com/docs/models/introduction#universal-classification) to leave only relevant provisions (dropping things like footnotes).
5. Every provision in an input document gets matched against every provision in a reference document, and the closest pairs are shortlisted.
6. Each shortlisted pair is scored for conflict with the universal classifier and [Kanon 2 Reranker](https://isaacus.com/docs/models/introduction#reranking).
7. The pairs are then sorted into deviations and gaps.

You can view the full article [Build a legal document conflict detector](https://isaacus.com/blog/build-a-legal-document-conflict-detector) on the website, or just open up the relevant cookbook.

## Files

- [`source_files/python/`](source_files/python/): original files created in python
- [`source_files/js/`](source_files/js/): JavaScript mirror of my Python files
- [`viewer.html`](viewer.html): demo app as a single page. It loads data from the `/api` of a running demo server (`source_files/<language>/web/server/run`).
- [`source_files/samples/`](source_files/samples/): sample documents to compare. Both cookbooks use them.
- [`deno.json`](deno.json): the npm packages the JS notebook imports, for the Deno kernel

If you look at the source files be careful of how things are wired up in the folders. Both the PY and JS versions use some of the same material.

Each cookbook is self-contained, so you only need one. Both produce the same results.

## Settings

Below is a summary of what the settings affect: findings, the speed of that part of the process, or the credits spent.

`document_index`:

- `EMBED_BATCH_SIZE = 96`: speed

`document_analysis`:

- `CLASSIFY_BATCH_SIZE = 50`: speed
- `CLASSIFY_MAX_PARALLEL_REQUESTS = 6`: speed
- `SHORTLIST_MIN_RELEVANCE = 0.5`: findings, speed and cost
- `SHORTLIST_TOP_K = 3`: findings, speed and cost
- `FILTER_THRESHOLD = 0.5`: findings
- `SAME_THRESHOLD = 0.3`: findings
- `CONFLICT_THRESHOLD = 0.728`: findings

`generation`:

- `BATCH_SIZE = 15`: speed and cost
- `MAX_PARALLEL_BATCHES = 20`: speed

Changing a threshold or the shortlist settings makes every saved comparison run again; the batch and parallel settings don't.
