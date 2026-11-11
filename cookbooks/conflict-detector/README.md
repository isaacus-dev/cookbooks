# Isaacus Legal Document Conflict Detector Cookbook

The Isaacus cookbook in this repo shows how to find conflicts between two legal documents. Findings consist of:

1. Deviation: two provisions that cover the same topic but don’t have the same legal effect.
2. Gap: a provision in one document with no agreement or difference in the other document.

## Getting started

- [`conflict_detector.ipynb`](conflict_detector.ipynb): the tutorial

The general process is as follows:

1. Documents are prepared beforehand, i.e. cleaned and then normalized.
2. The documents are split into segments with [Kanon 2 Enricher](https://isaacus.com/docs/models/introduction#enrichment).
3. The segments are embedded with [Kanon 2 Embedder](https://isaacus.com/docs/models/introduction#embedding).
4. The segments get filtered with [Kanon Universal Classifier](https://isaacus.com/docs/models/introduction#universal-classification) to leave only relevant provisions (dropping things like footnotes).
5. Every provision in an input document gets matched against every provision in a reference document, and the closest pairs are shortlisted.
6. Each shortlisted pair is scored for conflict with the universal classifier and [Kanon 2 Reranker](https://isaacus.com/docs/models/introduction#reranking).
7. The pairs are then sorted into deviations and gaps.

You can view the full article [Build a legal document conflict detector](https://isaacus.com/blog/build-a-legal-document-conflict-detector) on the website, or just open up the notebook.

## Files

- [`conflict_detector.ipynb`](conflict_detector.ipynb): the tutorial notebook
- [`generation.py`](generation.py): uses an LLM to write a recommended rewrite for each finding. The notebook imports it.
- [`viewer.html`](viewer.html): demo app as a single page
- [`server.py`](server.py): serves the viewer and runs comparisons with the notebook's functions. Start it from the cell at the end of the notebook's generation section.
- [`samples/`](samples/): sample documents to compare
- [`.env.example`](.env.example): copy to `.env` and add your API keys

## Settings

Below is a summary of what the settings affect: findings, the speed of that part of the process, or the credits spent.

A. Index a document:

- `EMBED_BATCH_SIZE = 96`: speed

B. Analyze documents:

- `CLASSIFY_BATCH_SIZE = 50`: speed
- `CLASSIFY_MAX_PARALLEL_REQUESTS = 6`: speed
- `SHORTLIST_MIN_RELEVANCE = 0.5`: findings, speed and cost
- `SHORTLIST_TOP_K = 3`: findings, speed and cost
- `FILTER_THRESHOLD = 0.5`: findings
- `SAME_THRESHOLD = 0.3`: findings
- `CONFLICT_THRESHOLD = 0.728`: findings

C. Generation ([`generation.py`](generation.py)):

- `BATCH_SIZE = 15`: speed and cost
- `MAX_PARALLEL_BATCHES = 20`: speed

Changing a threshold or the shortlist settings makes every saved comparison run again; the batch and parallel settings don't.
