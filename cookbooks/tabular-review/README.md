# Isaacus Tabular Review Cookbook

This cookbook shows how to build a tabular document review app using the Isaacus legal AI stack. It combines:

- [Kanon 2 Enricher](https://docs.isaacus.com/capabilities/enrichment) to convert uploaded documents into structured ILGS output.
- [Kanon 2 Embedder](https://docs.isaacus.com/capabilities/embedding) plus an in-memory Qdrant index for span-level semantic retrieval.
- [Kanon Answer Extractor](https://docs.isaacus.com/capabilities/extractive-question-answering) for query-driven entity linking and custom relationship extraction.

The project is made up of two parts:

- `tabular-review-server.ipynb` — a notebook that builds and runs a FastAPI server. The server accepts uploaded document text, enriches it into ILGS, indexes document segments for retrieval, and exposes endpoints for custom query columns.
- `tabular-review-client.html` — a lightweight front end that lets users upload documents, review extracted entities in a table, add custom query columns, and inspect the underlying ILGS document in an inline viewer.

Out of the box, the app surfaces core review columns such as Parties, Locations, Defined Terms, Signatures, and Dates, and supports custom columns for either span-based retrieval or entity-based extraction.

## Running the cookbook

Open and run the cells in [`tabular-review-server.ipynb`](tabular-review-server.ipynb). This starts the FastAPI server locally and serves the client at:

`http://127.0.0.1:8000`

Once the server is running, open the app in your browser, upload one or more documents, and begin reviewing them in tabular form.