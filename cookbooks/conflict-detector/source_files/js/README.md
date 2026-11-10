# JavaScript

```bash
npm install
node document_analysis.js --reference 09-disney-iger-amended-restated-employment-agreement-2011.md \
                          --input  08-disney-iger-employment-agreement-2022.md
web/server/run   # http://localhost:5000
```

| File | Does |
|---|---|
| `normalize.js` | cleans the text with `ftfy.js`; converts anything that isn't markdown with `text2markdown.js` first |
| `helpers/unicode.js` | Unicode code-point slicing and Python-compatible whitespace handling |
| `helpers/ftfy.js` | default text fixes from Python [ftfy](https://pypi.org/project/ftfy/) 6.3.1, with bundled encoding and HTML entity tables |
| `helpers/text2markdown.js` | port of the Python [text2markdown](https://github.com/isaacus-dev/text2markdown) library (0.1.5), which has no JavaScript version |
| `document_index.js` | Kanon 2 Enricher segments + Kanon 2 Embedder vectors, cached by content |
| `document_analysis.js` | compares one reference with one input, writes `results/reports/<reference>__<input>/` |
| `generation.js` | optional, for a saved comparison, with `MODEL`: in one pass, a short summary per finding (`summaries` in the report) and recommendations: the parties, and for each finding what each party should keep, remove or rewrite, and a rewrite (`recommendations` in the report). Never affects findings |
| `web/` | demo app: the findings page and the review page in `client/`, and their Express server in `server/` |

Code style: [STYLE.md](STYLE.md). Run `npm run lint` to check the pipeline modules.

## Pipeline

1. Drop non-operative segments: enricher front/back matter and annotations, and `FILTER_QUERY >= FILTER_THRESHOLD`. Definitions (clauses that open with a term the enricher marks as defined) skip the classifier and are always kept.
2. Shortlist each segment's top `SHORTLIST_TOP_K` counterparts at similarity `>= SHORTLIST_MIN_RELEVANCE`.
3. Score each pair:
   - `same_matter` from how strongly the two pick each other out (`MATCH_TEMPERATURE`, `SAME_*`)
   - `differs` from four prompts (`EMPTY_QUERY`, `CARE_STATEMENT`, `AGREE_QUERY`, `MONEY_STATEMENT`)
   - `conflict` combining the two (`CONFLICT_*`)
4. A pair is a deviation when one side is the other's best same-matter match and `conflict >= CONFLICT_THRESHOLD`. A segment with no counterpart at `same_matter >= SAME_THRESHOLD` is a gap, unless it is a definition.
5. Deviations and gaps are listed in document order.

A saved comparison is reused while `params.json` matches the current settings and both texts hash the same. Pass `--no-cache` to recompute.

## Text repair checks

Run `node --test test/ftfy.test.js` from this directory. The checked-in fixtures contain
4,002 expected outputs from Python ftfy 6.3.1, covering HTML entities, mixed encodings,
repeated mojibake, valid multilingual text, controls, and Unicode normalization.
JavaScript does not require Python at runtime. To regenerate the tables and fixtures
in a Python environment with `ftfy==6.3.1` installed:

```bash
python helpers/scripts/generate-ftfy-data.py
python helpers/scripts/generate-ftfy-fixtures.py
```

The port exposes `fixText(text)` with the default fixes; it does not expose Python's
configuration or explanation APIs. Derived tables and repair logic retain the upstream
notice in `helpers/ftfy-LICENSE.txt`.

## Python pipeline parity

The sections and corresponding functions in `document_index.js` and
`document_analysis.js` follow the Python files in the same order. JavaScript uses
camelCase names and options, plain-object factories (`createClause`,
`createDocumentIndex`, `createPairScore`), and `await` for asynchronous model calls.
Shared JSON and SDK field names retain their existing spelling.

Run `npm test` to check text repair and compare both pipelines offline using the
same enrichment, embedding, classification, and reranking fixtures. The parity
check runs the Python project next to this one (`uv sync` in `../python/` first); it uses
`../python/.venv/bin/python`, or `PYTHON_BIN` when set. It checks clauses,
Unicode spans, filtering, shortlists, scores, reports, and NumPy cache exchange.
Floating-point scores are compared with a tolerance of `1e-5`; report structure
and selected clauses must match. Equal similarities use document order as the
tie-breaker in both languages.

`helpers/unicode.js` handles Python/API code-point offsets and Python whitespace rules.
Generated ftfy tables and the server are outside the pipeline lint target.
