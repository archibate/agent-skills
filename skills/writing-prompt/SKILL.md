---
name: writing-prompt
description: "Create or edit agent-facing/LLM prompts using modern prompt-engineering practices. Use this skill before editing agent-facing docs, rule files, references, skills, memory, or any form of LLM prompt. Also use it before writing LLM tests or evaluations. This is mandatory: NEVER skip this skill before writing agent-facing text; MUST use it before editing a file that will be fed to AI agents."
---

# Writing Prompt

A prompt is read by a target model with known capabilities and a finite instruction budget. Size the prompt for that reader: lean, rational, unambiguous, and declarative. Do not benchmaxx evaluations. Allocate the budget by importance, and split the prompt when it outgrows that budget.

## Know your target model

First, identify which model your prompt targets.

- Agent-facing docs: `CLAUDE.md`, `SKILL.md`, `references/`, agent memory → assume the target model is the same as you, or another capable model with comparable abilities.
- LLM tests, evaluations, and benchmarks → use the model being tested.

Call it the *target model*—the audience you are writing for.

Assess the target model's capabilities, especially its instruction following and comprehension, based on its tier. If unsure, consult its pricing or SWE Pro scores. Tailor the prompt's strength to it.

**Why:** Capable flagship models and cost-efficient weaker models can vary in instruction-following ability. A pushy prompt that hard-codes every decision point may be necessary for a weaker model but unnecessarily constrain a flagship model. If heuristic guidance already produces stable behavior from a flagship model, its deliberate flexibility allows the model to apply its capabilities instead of following every instruction literally.

For agent-facing docs, assume the target model is yourself: the same model, but without your current context. Ask what would enable a fresh instance of you to understand the scenario and reliably make the same decisions. Do not repeat common knowledge that does not depend on context. If the audience is a flagship model comparable to you, GPT-3.5 era prompting is over-engineering.

## Build minimal working prompt

Clarify what you want to accomplish. Derive a minimal prompt from first principles that does the job. Prefer *rational*, *declarative* sentences.

**Why:** Keeping prompts minimal improves *interpretability* and reduces the risk of *overfitting*. Lengthy prompts also dilute attention and waste tokens.

Pushy prompts:

- ALL-CAPS: `ALWAYS use X.` → `Always use X.` (90%)
- Bold: `**Use X**.` → `Use X.` (70%)
- Negative: `Use X, not Y.` → `Use X.` (50%)
- Only: `Use X only if C.` → `Use X if C.` (30%)
- Justifying: `Use X (the correct form).` → `Use X.` (30%)

The precentage (%) shows calibration threshold above which pushy prompts becomes legitimate.

Default to rational prompts. Reserve pushy wording for cases in which a rational prompt would clearly fail because of missing context, ambiguity, or limited model capability, or when an instruction must survive budget pressure (see *Instruction budget*). Escalate gradually to pushier wording only after observing a failure.

**The rule:** If the target model would not do `Y` after seeing `Use X`, then `Use X, not Y.` is unjustified (see *When to use negative hedge*). If `**X**` does not improve the target model's attention to it, use plain `X`. If the target model likely already knows that `X` implies `the correct form`, that justification is redundant. If the model would not use `X` outside condition `C`, then `Use X if C` is more rational than `Use X only if C`.

**Authoritative reports**

Current OpenAI GPT-5.6 guidance reports that leaner system prompts improved internal coding-agent eval scores while reducing tokens and cost, and recommends stating each instruction once. ([GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model#favor-leaner-prompts))

For reasoning models specifically, current OpenAI guidance recommends simple, direct prompts, no chain-of-thought instructions, and try zero-shot before few-shot examples. ([reasoning-model guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices#how-to-prompt-reasoning-models-effectively))

## Instruction budget

Models have instruction budgets; a flagship model may have a budget of roughly 300 instructions. When too many instructions exceed that budget, the model has to discard some of them, diluting attention and harming instruction following.

More is not better. Do not pile up instructions merely to babysit the model. Spend the instruction budget only when required to produce stable behavior.

This is especially true for weaker models, which have smaller instruction budgets.

Prompts are easier for models to follow when:

- Prefer declarative sentences → they reduce perplexity and stabilize instruction following.
- Prefer positive forms to negative ones → negative forms consume the instruction budget faster; reserve them for critical pitfalls.
- Avoid contradictions between rules → resolving them consumes more of the budget.
- Use structural text when applicable → Markdown bullet points, with XML tags reserved for tree hierarchies.
- Avoid ASCII art or space padding → LLMs do not read them.

ALL-CAPS or bold formatting raises an instruction's priority. When the instruction budget is exhausted, the model discards lower-priority rules while emphasized ones remain in attention. Because emphasis continuously occupies attention, reserve it for important constraints that must remain salient in long contexts.

Size balancing: important or information-dense instructions justify a long top-level document; niche rules do not. Do not waste too much of the budget on minor items that are unlikely to be reused. If you cannot cut further, split the prompt; see `references/progressive-disclosure.md`.

**Why:** despite a flagship model may offer 300 instructions, a pushy skill occupying 100 instructions can shrink the budget available to other skills and user context.

## When to use negative hedge

Reserve a negative hedge for cases in which the negative branch is relevant or would be a common mistake unless stated explicitly. For example:

`Use chicken, not frog` is typically unjustified. A model would not think of "frog" anyway. In fact, mentioning "frog" in the context can counterintuitively increase the risk of using it because of context anchoring, especially for weaker models (from roughly 0% to 1%).

`Use chicken, not chick` is typically justified. This clearly requires a mature chicken, which is what we want; the negative branch catches the model *before* it uses "chick," which would be wrong.

This trades instruction budget for protection against a specific pitfall.

## References

- `references/testing-prompts.md` — read before writing or tuning LLM tests: evaluation/test split, overfitting, and sample clustering.
- `references/progressive-disclosure.md` — read when a prompt outgrows the instruction budget and you cannot cut further: split a lean entrypoint from details loaded on demand.
