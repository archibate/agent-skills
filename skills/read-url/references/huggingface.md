# HuggingFace

## Model / dataset README

For public repos, fetch the README directly as a file — same pattern as GitHub raw:

```bash
curl -sL 'https://huggingface.co/<org>/<name>/raw/main/README.md'
```

Works for both models and datasets (`huggingface.co/<org>/<name>` = model repo; `huggingface.co/datasets/<org>/<name>` = dataset repo — note the `/datasets/` segment for the dataset raw URL).

## Metadata

Clean JSON, no auth required for public content:

```bash
curl -sL 'https://huggingface.co/api/models/<id>'    | jq   # model card, tags, downloads, likes, pipeline_tag
curl -sL 'https://huggingface.co/api/datasets/<id>'  | jq   # dataset card, size, downloads
curl -sL 'https://huggingface.co/api/papers/<arxiv>' | jq   # paper title, authors, published models/datasets
```

The `papers` endpoint takes an arXiv ID (e.g. `2402.19173`) and returns HF's curated paper page — useful when a paper has an associated model or dataset on HF.

## Search

```bash
curl -sL 'https://huggingface.co/api/models?search=<q>&sort=downloads&direction=-1' | jq '.[] | {id, downloads, likes}'
curl -sL 'https://huggingface.co/api/datasets?search=<q>'                           | jq '.[] | {id, downloads}'
```

Returns ranked `id`s — fetch the README/metadata for a chosen one as above.

## Gated models

Some repos (Meta Llama, Google Gemma, etc.) require authentication. Any request to their raw files or sometimes the API returns:

```
Access to model <id> is restricted. You must have access to it and be authenticated to access it. Please log in.
```

Options:
1. Use an unrestricted equivalent (e.g. community mirrors or a different open model)
2. Read model details from the HF model page via `defuddle` — the page itself is often accessible even when the raw files aren't
3. If the user is authenticated via `huggingface-cli login`, the agent can fetch gated files via `huggingface-cli download <id> <file>` — but that requires their token, so ask first
