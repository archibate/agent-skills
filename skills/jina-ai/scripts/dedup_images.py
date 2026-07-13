#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Dedup images by visual similarity via Jina CLIP v2 embeddings.

Usage:
    scripts/dedup_images.py [-k N] [--json] PATH_OR_URL [PATH_OR_URL ...]
    ls *.png | scripts/dedup_images.py -k 5

Each input may be a local file path (read and base64-encoded), an
http(s):// URL, or a data: URI. Greedy farthest-point sampling on cosine
similarity: picks the first input, then iteratively adds the one whose
max similarity to already-picked is lowest. Prints kept inputs (original
strings) to stdout, one per line (or JSON with --json).

Requires JINA_API_KEY in the environment.
Exit codes: 0 success, 1 user/input error, 2 API/network error.
"""

import argparse
import base64
import json
import math
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.jina.ai/v1/embeddings"
MODEL = "jina-clip-v2"
BATCH = 16


def to_image(s):
    """Return the value to send in {'image': ...}: URL/data URI passthrough, else base64 of file."""
    if s.startswith(("http://", "https://", "data:")):
        return s
    p = Path(s)
    if p.is_file():
        return base64.b64encode(p.read_bytes()).decode()
    raise FileNotFoundError(s)


def embed(items, api_key):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "jina-ai-skill/dedup_images",
    }
    out = []
    for i in range(0, len(items), BATCH):
        body = json.dumps({"model": MODEL, "input": [{"image": x} for x in items[i:i + BATCH]]}).encode()
        req = urllib.request.Request(API_URL, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            out.extend(d["embedding"] for d in json.load(r)["data"])
    return out


def cos(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb)


def fps(vecs, k):
    n = len(vecs)
    if k >= n:
        return list(range(n))
    picked = [0]
    picked_set = {0}
    max_sim = [cos(vecs[0], v) for v in vecs]
    while len(picked) < k:
        nxt = min((i for i in range(n) if i not in picked_set), key=lambda i: max_sim[i])
        picked.append(nxt)
        picked_set.add(nxt)
        for i in range(n):
            s = cos(vecs[nxt], vecs[i])
            if s > max_sim[i]:
                max_sim[i] = s
    return picked


def main():
    p = argparse.ArgumentParser(
        description="Dedup images by visual similarity (Jina CLIP v2).",
        epilog="If no positional inputs are given, reads one path/URL per line from stdin.",
    )
    p.add_argument("inputs", nargs="*", help="local image paths or http(s)://… URLs")
    p.add_argument("-k", type=int, help="number of unique images to keep (default: n//2, min 1)")
    p.add_argument("--json", action="store_true", help="output JSON {kept, dropped}")
    p.add_argument("--api-key", help="Jina API key (default: $JINA_API_KEY)")
    args = p.parse_args()
    if args.k is not None and args.k < 1:
        p.error("-k must be >= 1")

    if args.inputs:
        inputs = args.inputs
    elif not sys.stdin.isatty():
        inputs = [ln.strip() for ln in sys.stdin if ln.strip()]
    else:
        inputs = []
    if not inputs:
        p.error("no inputs given (positional or stdin)")
    api_key = args.api_key or os.environ.get("JINA_API_KEY")
    if not api_key:
        print("error: $JINA_API_KEY not set (get one at https://jina.ai/?sui=apikey)", file=sys.stderr)
        sys.exit(1)

    try:
        images = [to_image(s) for s in inputs]
    except FileNotFoundError as e:
        print(f"error: not a URL and not an existing file: {e}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print(f"error: could not read input: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        vecs = embed(images, api_key)
    except urllib.error.HTTPError as e:
        print(f"error: API {e.code} {e.reason}: {e.read().decode(errors='replace')[:300]}", file=sys.stderr)
        sys.exit(2)
    except urllib.error.URLError as e:
        print(f"error: network: {e.reason}", file=sys.stderr)
        sys.exit(2)
    except (KeyError, TypeError, json.JSONDecodeError) as e:
        print(f"error: malformed API response: {e}", file=sys.stderr)
        sys.exit(2)

    k = args.k if args.k is not None else max(1, len(inputs) // 2)
    idx = fps(vecs, k)
    kept = [inputs[i] for i in idx]

    if args.json:
        kept_idx = set(idx)
        dropped = [s for i, s in enumerate(inputs) if i not in kept_idx]
        json.dump({"kept": kept, "dropped": dropped}, sys.stdout)
        sys.stdout.write("\n")
    else:
        for s in kept:
            print(s)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
