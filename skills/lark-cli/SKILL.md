---
name: lark-cli
description: >
  Lark/Feishu (飞书) CLI tool. Use when the user asks to do anything on Lark/Feishu — send or read chat messages (IM), read or edit docs/sheets/slides/wiki, work with multi-dimensional tables (Base/bitable), manage calendar/meetings/video-conference, mail, contacts, tasks, approvals, OKR, drive files, minutes, whiteboards, or attendance. Triggers: "lark", "feishu", "send a feishu message", "peek lark group messages", "conclude last lark meeting".
---

# Lark/Feishu CLI Skill

Official Lark/Feishu CLI tool: `lark-cli`

## Workflow

Before start, run these three commands:

```bash
echo "=== Auth status ==="
lark-cli auth status                       # verify login status
echo "=== List of skills ==="
lark-cli skills list                       # list all available skills (read on demand)
echo "=== Shared knowledge ==="
lark-cli skills read lark-shared/SKILL.md  # common knowledge you should generally follow
```

The CLI embeds version-matched agent guidance — read it before choosing flags:

```bash
lark-cli skills read lark-im/SKILL.md
```

Reading the skill will teach you how to use the `lark-cli im` interface.

Optionally read the references docs mentioned in SKILL.md on demand:

```bash
lark-cli skills read lark-im/references/lark-im-chat-list.md
```

## Pitfalls

- If `lark-cli` is not available, fallback to `npx -y @larksuite/cli`.
- Never run `npx skills add larksuite/cli -g -y`.
