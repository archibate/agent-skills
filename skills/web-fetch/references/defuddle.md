# Defuddle

Extract clean readable content from generic web pages via `npx defuddle`. Removes navigation, ads, sidebars — returns only the main content as markdown.

## Usage

Markdown output:

```bash
npx defuddle parse <url> --markdown
```

Extract metadata only:

```bash
npx defuddle parse <url> --property title
npx defuddle parse <url> --property description
```

## Fallback when output is partial or wrong

Defuddle's heuristics work well on single-article pages (blogs, docs) but get noisy on complex layouts — comments, vote stats, and metadata can get interleaved with the actual content. If the raw `curl -sL <url>` returns full HTML but defuddle's output drops sections or buries them in chrome, slice by CSS selector — see `html-selector.md`.
