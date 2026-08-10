---
name: writing-prompt
description: "Create or edit agent-facing/LLM prompts with modern prompt engineering best practices. Use this skill before editing agent-facing docs, rule files, references, skills, memory, or any form of LLM prompts. Also use before writing LLM tests or evaluation. This is mandatory: NEVER skip this skill before writing any agent-facing text; MUST use this skill before editing a file will be fed into AI agents."
---

# Writing Prompt

A prompt is read by a target model with known capability and a finite instruction budget. Size the prompt to that reader: minimal, rational, unambiguous, declarative. No benchmaxxing evaluation. Schedule budget by importance, split when it outgrows.

## Know your target model

First know what model your prompt is targeting to.

- agent-facing docs: `CLAUDE.md`, `SKILL.md`, `references/`, agent memory -> assume target model is the same as you (or a decent competitive model equally capable as you).
- LLM testing/evaluation/benchmark -> you know the model being tested.

Call it the *target model* - it's the audience you are writing for.

Understand the target model capabilities (especially in instruction following & understanding) by its grade (if not sure, look for its pricing, or SWE Pro scores). Tailor prompt strength to it.

**Why:** Decent flagship models and cost-efficient weak models can vary in instruction following. A pushy prompt enumerating all decision points (hard-coded) is only tolerated to pet weak models, not for flagship models; a heuristic prompt (if already stabilize flagship models) with lossy guidance allow flagship models to better apply capabilities - flexible in approach instead of strict follow of literal instruction.

In agent-facing docs, assume the target model is yourself - same model, except they don't see your current context. Think if you didn't have the context, what will make that fresh "you" to understand the scenario and stably do the same thing? You know your prior knowledge and ability, no repeating a common prior knowledge not depend on context. If you know the audience is a flagship model same as you, applying GPT-3.5-Turbo era prompts would be prompt over-engineering.

## Build minimal working prompt

Clarify what you want to do. Derive a minimal prompt from first-principles that does the job. Prefer *rational*, *declarative* sentence.

**Why:** Keeping things minimal improves *interpretability*, reduces *over-fitting* risk; lengthy prompts also dilutes attention and waste tokens.

Pushy prompt smell:

- ALL-CAPS: `ALWAYS use X.` -> `Use X.`
- Bold: `**Use X**.` -> `Use X.`
- Negative: `Use X, not Y.` -> `Use X.`
- Only: `Use X only if C.` -> `Use X if C.`
- Justifying: `Use X (the correct form).` -> `Use X.`

Default to the rational prompts. Spare the pushy prompts only if rational prompt would definitely fail (lack of context, ambiguity, or poor model capability), or if the instruction must survive budget pressure (see *Instruction budget*).

**The rule:** if the target model won't do `Y` anyway at the moment seeing `Use X`, then `Use X, not Y.` doesn't legitimate (see *When to use negative hedge*); if `**X**` doesn't improve attention to target model, then why not plain `X`; if target model prior knowledge likely already know `X` implies `the correct form`, then justifying `X (the correct form)` is nonsense; if model won't use `X` in not `C` condition, then `Use X if C` is more rational than `Use X only if C`.

## Instruction budget

Models have instruction budgets, a flagship model may have 300-ish instruction budget. When pushing too much instructions beyond budget, model have to discard some instruction -> dilutes attention, harms instruction following.

More is not better. Do not pile up instructions just for baby-sitting. Spare instruction budget only when it's required to do the job stably.

This becomes especially true for weak models (less instruction budget).

Prompts are easier for models to follow when:

- Prefer declarative sentence -> reduces perplexity, more stable instruction following.
- Prefer positive form, not negative form -> negative form consumes instruction budget faster (spare for critical pitfalls to avoid).
- Avoid contradiction in rules -> cost more budget to decide what to follow.
- Structural text when applicable -> Markdown bullet points, XML tags (spare for tree hierarchy).
- No ASCII art or space padding -> LLM doesn't read.

ALL-CAPS or bold schedules an instruction to higher priority. When instruction budget exhausted, model discard rules at low priority, your ALL-CAPS remains in attention. Constantly occupying attention, only spare for important constraints must not dilute over long-context.

Size balancing: important or information-dense instructions legitimates a long size in top document; niche rules doesn't. Do not waste too much budget on minor items with little likelihood of reuse. Can't cut further -> split, see `references/progressive-revealing.md`.

## When to use negative hedge

Spare negative hedge only when the negative branch is relevant, or a common mistake if not spoken loudly. E.g.:

`Use chicken, not frog` typically doesn't legitimate. A model never think about "frog" anyway. In fact the mentioning of "frog" in context counter intuitively increase the risk of using "frog" due to context-anchoring (raised from ~0% to 1%) especially for weak models.

`Use chicken, not chick` typically does legitimate. This clearly enforces the use of "mature chicken" (which we want), the negative branch precisely catches model *before* using "chick" (which is wrong).

This trade instruction budget for pitfall catch.

## References

- `references/testing-prompts.md` — read before writing or tuning LLM tests: eval/test split, over-fitting, sample clustering.
- `references/progressive-revealing.md` — read when a prompt outgrows the instruction budget and you can't cut further: splitting a lean entry from on-demand detail.
