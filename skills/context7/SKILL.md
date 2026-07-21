---
name: context7
description: >
  Fetch current docs and code examples for third-party libraries, SDKs, APIs, and CLI tools via Context7. Use before writing or editing non-stdlib library calls — your prior knowledge may be stale. Prefer over web search for library docs.
---

# Context7

Fetch up-to-date library documentation and code examples. Requires `CONTEXT7_API_KEY` environment variable.

## When not to use

Skip Context7 for internal/private libraries, stdlib code, raw HTTP/filesystem, shell built-ins, or stable primitives whose signatures haven't changed in years (e.g. `json.dumps`, `os.path`).

## resolve-library-id

Resolve a package/product name to a Context7 library ID. Call this before `query-docs` unless the user provides an ID in `/org/project` format.

- `libraryName` (required): Official library name (e.g., "Next.js", "Three.js")
- `query` (required): What the user needs help with — used to rank results by relevance

```bash
uv run scripts/mcpcall.py resolve-library-id libraryName:"Next.js" query:"app router setup"
```

## query-docs

Retrieve documentation and code examples for a resolved library.

- `libraryId` (required): Context7 library ID from `resolve-library-id` (e.g., "/vercel/next.js")
- `query` (required): Specific question — be detailed for better results

```bash
uv run scripts/mcpcall.py query-docs libraryId:"/vercel/next.js" query:"how to set up authentication with JWT"
```
