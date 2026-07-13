# Archibate's Agent Skills

A curated collection of reusable agent skills for C++ design and HPC,
profiling, browser and web research, long-running task supervision, architecture
work, and developer tooling.

## Install

Copy the skill you need into the skill directory used by your agent. Codex uses
`~/.codex/skills` by default:

```bash
cp -a skills/cpp-hpc-optimization ~/.codex/skills/
```

Install additional skill folders the same way. Read each `SKILL.md` for its
trigger conditions and external requirements. Some skills depend on local CLIs
or API credentials that are not included here.

Do not copy `skills/.system`; Codex installs and updates its built-in skills
itself, and this repository intentionally excludes them.

## Highlights

- `cpp-hpc-optimization` — evidence-driven C++ HPC design, profiling, data
  layout, numerics, SIMD, multicore, and accelerator optimization, with a
  curated Parallel101 teaching corpus.
- `cpp-oop-style` — Archibate's type-rich, ownership-aware C++ design style.
- `agent-browser`, `chrome-cdp`, `read-url`, and `scrapling` — browser
  inspection and web-content workflows.
- `babysit` and `tmux` — supervised long-running and interactive tasks.
- `context7`, `grep-app`, and `jina-ai` — documentation, code, and research
  retrieval.
- `fresh-arch` and `grill-me` — architecture design and design interrogation.

Licensing and provenance are recorded within the relevant skill directories.
The `cpp-hpc-optimization` corpus includes pinned source paths, commits, hashes,
and attribution in `references/parallel101/provenance.tsv`.
