# Semantic Legal Citation Graph Cookbook
This Isaacus Cookbook teaches you how to extract citations from legal documents, classify them by treatment, cluster them by area of law, and then visualize the resulting knowledge graph interactively in 3D.

Isaacus' [Kanon 2 Enricher](https://docs.isaacus.com/models/introduction#enrichment) document enrichment model is used to extract and classify entities in documents, while [Kanon 2 Embedder](https://docs.isaacus.com/models/introduction#embedding) is used to represent documents as vectors for clustering and dimensionality reduction. Isaacus' open source dataset of [Australian High Court cases](https://huggingface.co/datasets/isaacus/open-australian-legal-corpus) is also used as an example corpus, however, this Cookbook can easily be adapted to work with any other corpus, including non-legal corpora.

To run this Cookbook, follow the instructions in the [Jupyter notebook](semantic-legal-citation-graph.ipynb) in this folder.