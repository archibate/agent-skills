---
name: apply-feedback
description: Apply an user feedback to future sessions, changes agent default behavior. Use this skill when user wants to permanantly apply a feedback, save a preference, remember a lesson, or asked "next time", "remember this", "in future sessions", "never again". Offer this skill after agent mistake was corrected by user.
---

# Apply user feedback

## Scope

Given the user feedback, resolve three questions (infer from context or ask user):

- **Persistence**:
  - Apply permanantly (affects future sessions) → use this skill
  - Ephemeral in-session constraint (forget on exit) → skip this skill
- **Which workspace**:
  - Feedback applies globally (affects all other projects) → global rule file
  - Only matters in current project (session in current workspace) → project rule file
- **Which agent**:
  - Claude Code → `<project>/CLAUDE.md`, `~/.claude/CLAUDE.md`
  - Other → `<project>/AGENTS.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, ...

## Format

Create or update the `## User Feedback` session, in this format:

```markdown
## User feedback

These are real conversation snippets cited from history sessions between user and assistant. Each lesson is a pattern corrected by user feedback. Manage with `$apply-feedback` skill.

**IMPORTANT:** BEFORE your next response matched ANY of the assistant trajectory below, apply the corresponding user feedback (last message in each lesson) IMMEDIATELY.

<lessons>
  <lesson name="always-reply-in-chinese">
    <message role="user">
      Earth
    </message>
    <message role="assistant">
      Let me search for the planet Earth.
      <tool_calls>
        <tool_call name="web_search" tool_call_id="1">{"keyword":"Planet Earth"}</tool_call>
      </tool_calls>
    </message>
    <message role="tool" tool_call_id="1">
      Earth is the third planet from the Sun and the only astronomical object known to harbor life. This is made possible by Earth being an ocean world, the only one ...
    </message>
    <message role="assistant">
      Good question! **Earth** is the third planet from ...
    </message>
    <message role="user">
      Next time, please always reply in Chinese even if I ask in English.
    </message>
  </lesson>
  <lesson name="some-random-lesson">
    ...
  </lesson>
</lessons>
```

Copy the real conversation from your context verbatim, except for exact UUIDs and sensive data redacted.

Do not invent fabricate conversations. Do not add narrative. Do not explain.

Range from the first involved user message before assistant mistake, to the user feedback message. Delibirately drop the assistant response to user feedback (low-information self-reflection or apologize).

Only trim lesson if longer than 100 lines by cutting off early context or omitting unimportant content.
