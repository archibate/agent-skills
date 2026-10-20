---
name: apply-feedback
description: Apply a user feedback to future sessions, changing agent default behavior. Use this skill when user wants to permanently apply a feedback, save a preference, remember a lesson, or asked "next time", "remember this", "always do", "in future sessions", "never again". Offer this skill after agent mistake was corrected by user.
---

# Apply user feedback

## Scope

Given the user feedback, resolve two questions (infer from context or ask user):

- **Persistence**:
  - Apply permanently (affects future sessions) → use this skill
  - Ephemeral in-session constraint (forget on exit) → skip this skill
- **Which workspace**:
  - Feedback applies globally (affects all other projects) → global rule files
  - Only matters in current project (session in current workspace) → project rule files

In Claude Code, this skill replaces the built-in memory for feedback; do not also save a feedback memory.

## Target files

Global: update every one of these that exists, so the lesson reaches all agents:

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.config/opencode/AGENTS.md`
- `${PI_CODING_AGENT_DIR:-~/.pi/agent}/AGENTS.md`

Project: update `<project>/AGENTS.md` and `<project>/CLAUDE.md` where they exist; if one is a symlink to or imports the other, write once.

These files may contain an installer-managed block between `<!-- archibate/agent-skills:begin -->` and `<!-- archibate/agent-skills:end -->`; reinstall overwrites it. Place the section after the end marker. Do not edit `~/.agents/AGENTS.md`: it is the installer source, committed to a public repo.

## Format

Create or update the `## User feedback` section, in this format:

```markdown
## User feedback

These are real conversation snippets cited from history sessions between user and assistant. Each lesson is a pattern corrected by user feedback. Manage with `$apply-feedback` skill.

**IMPORTANT:** BEFORE your next response matches ANY of the assistant trajectory below, apply the corresponding user feedback (last message in each lesson) IMMEDIATELY.

<lessons>
  <lesson name="use-uv-not-pip">
    <message role="user">
      Add requests to this project
    </message>
    <message role="assistant">
      <tool_calls>
        <tool_call name="bash" tool_call_id="1">{"command":"pip install requests"}</tool_call>
      </tool_calls>
    </message>
    <message role="tool" tool_call_id="1">
      Successfully installed requests-2.32.3
    </message>
    <message role="assistant">
      Installed `requests`.
    </message>
    <message role="user">
      Never use pip in my projects, always `uv add`.
    </message>
  </lesson>
  <lesson name="some-random-lesson">
    ...
  </lesson>
</lessons>
```

Transcribe the real conversation from your context into this schema, keeping message text verbatim. Redact secrets, tokens, personal data, and exact UUIDs.

Do not fabricate conversations. Do not add narrative. Do not explain.

Range from the first involved user message before assistant mistake, to the user feedback message. Deliberately drop the assistant response to user feedback (low-information self-reflection or apology).

Only trim lesson if longer than 100 lines by cutting off early context or omitting unimportant content.

If an existing lesson covers the same pattern, replace it with the new one instead of appending a duplicate.
