---
name: writing-prompt
description: "Create or edit agent-facing/LLM prompts using modern prompt-engineering practices. Use this skill before editing agent-facing docs, rule files, references, skills, memory, or any form of LLM prompt. Also use it before writing LLM tests or evaluations. This is mandatory: NEVER skip this skill before writing agent-facing text; MUST use it before editing a file that will be fed to AI agents."
---

# Writing Prompt

A prompt is read by a target model with particular capabilities. Size the prompt for that reader: lean, rational, unambiguous, and direct. Do not benchmaxx evaluations. Allocate detail by importance, and split the prompt when essential guidance becomes hard to find.

## Know your target model

First, identify which model your prompt targets.

- Agent-facing docs: `CLAUDE.md`, `SKILL.md`, `references/`, agent memory → assume the target model is the same as you, or another capable model with comparable abilities.
- LLM tests, evaluations, and benchmarks → use the model being tested.

Call it the *target model*—the audience you are writing for.

Tailor the level of detail to the target model's instruction following and comprehension, using observed behavior on relevant tasks when available.

**Why:** Models can vary in how much explicit guidance they need. If heuristic guidance already produces stable behavior, its flexibility allows the model to use context and judgment without having every decision prescribed.

For agent-facing docs, assume the target model is yourself: the same model, but without your current context. Ask what would enable a fresh instance of you to understand the scenario and reliably make the same decisions. Do not repeat common knowledge that does not depend on context. If the audience is a flagship model comparable to you, GPT-3.5 era prompting is over-engineering.

## Build a minimal working prompt

Clarify what you want to accomplish. Derive a minimal prompt from first principles that does the job. Prefer *rational*, *direct* sentences.

**Why:** Concise prompts are easier to inspect and maintain. Extra detail can obscure important constraints, add token cost, and overfit the prompt to individual examples.

Possible simplifications, when the intended meaning is preserved:

- ALL-CAPS: `ALWAYS use X.` → `Always use X.`
- Bold: `**Use X**.` → `Use X.`
- Negative: `Use X, not Y.` → `Use X.`
- Justifying: `Use X (the correct form).` → `Use X.`

Default to rational prompts. Add missing context or resolve ambiguity before strengthening the wording. Escalate emphasis gradually when observed failures show that an important instruction is being missed (see *Instruction budget*).

**The rule:** If the target model would not do `Y` after seeing `Use X`, then `Use X, not Y.` is unjustified (see *When to use a negative hedge*). If `**X**` does not improve the target model's adherence to the instruction, use plain `X`. If the target model likely already knows that `X` implies `the correct form`, that justification is redundant.

For reasoning models specifically, OpenAI recommends simple, direct prompts, avoiding chain-of-thought instructions, and trying zero-shot prompting before adding few-shot examples. ([Reasoning-model guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices#how-to-prompt-reasoning-models-effectively))

## Instruction budget

Use *instruction budget* as a design metaphor for the difficulty of following many competing requirements. Practical limits depend on the model, task, and context; this is not a fixed count of instructions.

Keep instructions that materially affect behavior, including triggers, actions, and recovery steps. Do not delete useful instructions merely to reduce word count. Include the author's working context, design history, and implementation details only when the target model needs them to decide or act correctly. Catch yourself before story-telling in prompts.

To make the prompt easier to follow:

- Use direct sentences that make the requested behavior clear.
- Prefer positive wording when it fully expresses the requirement; retain negative constraints for relevant pitfalls.
- Resolve contradictions so the model has a consistent set of rules to follow.
- Group related instructions under descriptive headings, using consistent heading levels to make topics and subtopics easy to locate.
- Use Markdown for prose and lists. Use descriptive XML tags when explicit start/end markers help delimit content without relying on semantic cues or indentation. Few-shot examples and nested content are common cases; see *How to use `when`*.
- Use concise pseudocode in fenced code blocks only when it clarifies control flow, execution order, or branch boundaries.
- Prefer explicit labels and relationships over layouts that depend on ASCII art or space padding.

ALL-CAPS or bold formatting may make an instruction more noticeable, but does not guarantee priority or reliable compliance. Reserve emphasis for important constraints.

Size balancing: important or information-dense instructions justify a long top-level document; niche rules do not. Do not waste too much of the budget on minor items that are unlikely to be reused. If you cannot cut further, split the prompt; see `references/progressive-disclosure.md`.

## When to use a negative hedge

Reserve a negative hedge for cases in which the negative branch is relevant or would be a common mistake unless stated explicitly. For example:

`Use chicken, not frog` adds little unless frog is a plausible alternative in the task.

`Use chicken, not chick` can be justified when confusing an adult bird with a young one is a plausible mistake. If maturity is the requirement, `Use a mature chicken` states it directly.

The extra wording earns its place when it prevents a plausible mistake.

## How to use `when`

Let `X` be the action and `Y` the condition. Distinguish a trigger from a prerequisite:

- `Do X when Y`: When `Y` holds, do `X`. This instruction alone does not specify what to do when `Y` is false.
- `Do X only when Y`: When `Y` is false, do not do `X`. When `Y` holds, this instruction alone does not require `X`.
- `Do X if and only if Y`: When `Y` holds, do `X`; otherwise, do not do `X`. Two requirements in one sentence; spends 2x instruction budget.

The same distinction applies to `if` and `only if`. These meanings differ even when `Y` is objective; preserve `only` when it carries the intended restriction.

With subjective conditions, wording may also influence how readily the model judges the condition satisfied. The following tendencies were reported in use:

<example>
  <prompt>Times out after 900 seconds by default; set `TIMEOUT_SECONDS` when a different bound is justified.</prompt>
  <behavior>The model tended to override the default timeout on each call.</behavior>
</example>
<example>
  <prompt>Times out after 900 seconds by default; set `TIMEOUT_SECONDS` only when a different bound is justified.</prompt>
  <behavior>The model tended to omit `TIMEOUT_SECONDS` and keep the default.</behavior>
</example>

In this example, `only when` reinforced the default of leaving the timeout unchanged. Choose the wording by its intended meaning first, then refine it using observed behavior from the target model.

## Decision boundaries

Avoid restating routine safety boundaries that the target model already handles reliably. Focus on task-specific requirements that needs explicit guidance.

Overly broad cautionary language can cause unnecessary hesitation. OpenAI notes that GPT-6 Astra may take boundary language written for earlier models too seriously and stop where the user would expect it to continue. ([OpenAI guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra#decision-boundaries))

## References

- `references/testing-prompts.md` — read before writing or tuning LLM tests: evaluation/test split, overfitting, and sample clustering.
- `references/progressive-disclosure.md` — read when a prompt outgrows the instruction budget and you cannot cut further: split a lean entrypoint from details loaded on demand.
