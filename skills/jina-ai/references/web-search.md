# Web search

Read this page before general web search, filtered search, blog search, or query expansion. Use the academic or image route instead for paper and image searches.

## Search

```bash
jina search "what is BERT"
jina search --blog "embeddings"
jina search "AI news" --time d                  # past day (h|d|w|m|y)
jina search "深度学习" --gl cn --hl zh-cn       # Chinese region/language
jina search "LLM" --location "Shanghai"
jina search "site:github.com claude code hooks" # Google-style operators pass through
```

Google-style operators include `site:`, quoted phrases, `-exclude`, `OR`, `intitle:`, and `inurl:`.

Use `--gl cn --hl zh-cn` for Chinese results and `--time w` for the past week.

## Query expansion

Generate related queries with:

```bash
jina expand "machine learning optimization"
```

## Tool selection

| Scenario | Tool |
|---|---|
| Generic web search | `jina search` |
| Jina service unreachable | WebSearch (built-in) |
