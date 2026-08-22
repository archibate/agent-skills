# Web reading

Read this page before extracting a web page or estimating its publication or update date.

## Read pages

```bash
jina read https://example.com
jina read https://example.com --links --images
```

## Estimate publication time

```bash
jina datetime https://example.com/article
```

`jina datetime` guesses the publication or update date of a URL.

## Tool selection

| Scenario | Tool |
|---|---|
| Read a web page | `jina read`; use the `$read-url` skill if it does not work |
