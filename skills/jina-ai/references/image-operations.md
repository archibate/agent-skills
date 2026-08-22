# Image operations

Read this page before image search, webpage screenshots, or visual image deduplication.

## Search images

```bash
jina search --images "neural network diagram"
```

## Capture screenshots

```bash
jina screenshot https://example.com                    # print screenshot URL
jina screenshot https://example.com -o page.png        # save to a file
jina screenshot https://example.com --full-page -o page.jpg
```

## Deduplicate images

Use the bundled script because `jina dedup` is text-only:

```bash
scripts/dedup_images.py *.png                          # local paths; keep n//2 by default
scripts/dedup_images.py -k 5 --json img1.jpg img2.jpg
ls images/*.png | scripts/dedup_images.py -k 3
scripts/dedup_images.py https://example.com/a.png /tmp/b.png
```

The script calls `https://api.jina.ai/v1/embeddings` with model `jina-clip-v2` and uses greedy farthest-point sampling on cosine similarity. It base64-encodes local paths and passes `http(s)://` and `data:` URIs through. Prefer local paths because Jina's URL fetcher cannot reach some hot-link-protected hosts, including Wikimedia and certain CDNs.
