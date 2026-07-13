---
name: fresh-arch
description: Architecture design reasoned forward from requirements. Use when the user wants a fresh-mind design pass — "design an architecture for", "how would you build", "redesign from scratch" — or when repeated follow-up patches accumulate on the same module. Repeated follow-up patches landing on the same module (~3rd) → stop patching, invoke this skill to re-derive from the full requirement set.
argument-hint: "[plan or topic to design architecture on]"
---

$ARGUMENTS

Design an architecture for the topic above by reasoning forward from requirements. If a codebase exists, you may Read/Grep it — but only as evidence to evaluate, not as a frame to fit the new design into.

**Mindset**

Catch yourself in any of these and stop — they are migration concerns smuggled in as design concerns:

- "the current code does X, so the new design should look similar"
- "we need to stay backward-compatible with X"
- "let's stick to the existing module boundaries / pattern / abstractions"
- "let's not be too aggressive / disruptive / far from what the team knows"
- "X is already wired up, so reuse it"

If a current pattern survives, it survives on merit — because it is the right answer when reasoned forward from requirements — not because it is already there.

**Output**
1. **Problem** — 1-3 lines, what the system must do (not how).
2. **Components** — 3-7 boxes, each with a one-sentence responsibility. Justify why these and not fewer/more.
3. **Contracts** — interfaces / message shapes between components.
4. **Data & state** — what's stored where, consistency model, lifecycle.
5. **Rejected alternatives** — at least one different shape you considered and why this one wins.
6. **Critique of the current design** *(if a codebase exists)* — judged against the design above. What the current system gets wrong, what it accidentally gets right, what is load-bearing vs. incidental. Not a migration plan; migration is a separate problem.
