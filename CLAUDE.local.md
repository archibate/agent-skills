# Archibate's Agent Skills

A curated collection of reusable agent skills for C++ design and HPC,
browser automation, web research, architecture work, writing, and developer
tooling.

## Install

The interactive installer for Codex, OpenCode, or Claude Code:

```bash
./install.sh
```

Running from a complete Git checkout links selected skills back to this repository
by default, so `git pull` updates them in place. Keep the checkout at a stable path,
or pass `--install-mode copy` for independent copies. Piped archive installations
copy automatically because their source directory is temporary.

Codex and OpenCode discover personal skills under `~/.agents/skills`; Claude
Code uses `~/.claude/skills`. The installer resolves skill dependencies, checks
external requirements, and merges `AGENTS.md` into each selected agent's global
guidance without replacing unrelated user content.

For a noninteractive core installation:

```bash
./install.sh --profile core --targets codex,opencode --yes
```

Do not copy `skills/.system`; Codex installs and updates its built-in skills
itself, and this repository intentionally excludes them.

### Metadata

所有技能、默认选项、硬依赖、推荐关系和运行时检查都集中在 [`installer/catalog.tsv`](installer/catalog.tsv)。以后新增或移除技能，通常只需改技能目录和一行清单；若引入全新的外部工具，再给 [`installer/main.sh`](installer/main.sh) 增加一个显式处理器，杜绝把任意 shell 命令塞进数据文件里偷偷执行。

提交前验证清单、依赖图和安装流程：

```bash
installer/main.sh --source-root . --validate
tests/installer_test.sh
```

从清单移除技能只会让它不再出现在新安装中，不会静默删除用户机器上已经安装的副本。

## Agent guidance

[`AGENTS.md`](AGENTS.md) is a standalone engineering discipline for agents:
evidence-first investigation, explicit decision-making, first-principles design,
and honest validation. Copy or adapt it at a repository root when you want
these cross-cutting behaviors alongside the task-specific skills.

## Highlights

- [`AGENTS.md`](AGENTS.md) — evidence-first agent behavior and engineering
  discipline for repository work.
- `cpp-hpc-optimization` — evidence-driven C++ HPC design, profiling, data
  layout, numerics, SIMD, multicore, and accelerator optimization, with a
  curated Parallel101 teaching corpus.
- `cpp-oop-style` — Archibate's type-rich, ownership-aware C++ design style.
- `agent-browser` and `chrome-cdp` — headless and user-visible browser
  automation workflows.
- `context7`, `grep-app`, `jina-ai`, `read-url`, and `scrapling` —
  documentation, code, research, and web-content retrieval.
- `fresh-arch` and `grill-me` — architecture design and design interrogation.
- `lark-cli` — Lark/Feishu messaging, documents, calendars, and task workflows.

Unless a file says otherwise, this repository's original material is licensed
under [CC BY-NC-SA 4.0](LICENSE). Third-party and vendored material retains its
own license and attribution; see the relevant skill directory. The
`cpp-hpc-optimization` corpus includes pinned source paths, commits, hashes,
and attribution in `references/parallel101/provenance.tsv`.
