# Python

```bash
uv run document_analysis.py --reference 09-disney-iger-amended-restated-employment-agreement-2011.md \
                            --input  08-disney-iger-employment-agreement-2022.md
web/server/run   # http://localhost:5000
```

| File | Does |
|---|---|
| `normalize.py` | cleans the text; converts anything that isn't markdown with [text2markdown](https://github.com/isaacus-dev/text2markdown) first |
| `document_index.py` | Kanon 2 Enricher segments + Kanon 2 Embedder vectors, cached by content |
| `document_analysis.py` | compares one reference with one input, writes `results/reports/<reference>__<input>/` |
| `generation.py` | optional, for a saved comparison, with `MODEL`: in one pass, a short summary per finding (`summaries` in the report) and recommendations: the parties, and for each finding what each party should keep, remove or rewrite, and a rewrite (`recommendations` in the report). Never affects findings |
| `../../conflict_detector_python.ipynb` | the tutorial's code as a notebook, generated from the post |
| `web/` | demo app: the findings page and the review page in `client/`, and their Flask server in `server/` (`uv run --group web`) |

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
