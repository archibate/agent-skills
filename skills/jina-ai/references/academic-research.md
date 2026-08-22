# Academic research

Read this page before searching, reading, citing, or extracting figures, tables, and equations from academic papers.

## Route by goal

| Goal | Command |
|---|---|
| Find STEM papers | `jina search --arxiv` |
| Read abstract and metadata | `jina read arxiv.org/abs/<ID>` |
| Read the full paper as markdown | `jina read arxiv.org/pdf/<ID>` |
| Extract figures, tables, or equations | `jina pdf <ID>` |
| Resolve a citation | `jina bibtex "<title>"` |
| Save the raw PDF | `curl -L -o paper.pdf arxiv.org/pdf/<ID>` |

## Find papers

```bash
jina search --arxiv "attention mechanism" -n 10
jina search --arxiv "diffusion transformer" -n 10 --json \
  | jq -r '.results[] | "\(.title)\t\(.url)"'
```

## Read arXiv papers

Choose the URL form deliberately:

```bash
# Abstract and metadata, roughly 2 KB
jina read https://arxiv.org/abs/1706.03762

# Full paper body as markdown, roughly 40 KB for a conference paper
jina read https://arxiv.org/pdf/1706.03762 > paper.md
```

## Extract PDF content

```bash
jina pdf https://arxiv.org/pdf/2301.12345
jina pdf 2301.12345
jina pdf https://example.com/paper.pdf --type figure,table
```

## Resolve BibTeX

`jina bibtex` searches DBLP and Semantic Scholar.

```bash
jina bibtex "attention is all you need"
jina bibtex "transformer" --author Vaswani --year 2017
```
