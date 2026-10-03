# Image operations

Read this page before image search or visual deduplication of image results. For webpage screenshots, use the `$web-fetch` skill.

## Search images

```bash
jina search --images "neural network diagram"
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
