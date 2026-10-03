---
name: fresh-arch
description: >
  Re-derive a fresh-mind architecture design reasoned forward from requirements. Use this skill before applying follow-up patches, feature changes potentially shift optimal design, or refactorization on a pre-existing codebase. Does not apply to empty codebase or new project.
---

Design an architecture for the user request by reasoning forward from requirements, not anchoring pre-existing design or conversation.

**Steps**

1. Explore pre-existing codebase ONLY as evidence to understand current situation, not as a frame to fit the new design into.
2. Analysis user intent: what are the new features they want to have (add), what existing features they no longer require (delete), what existing features are out of scope (keep).
3. Clarify what the system must do (not how), and must not do.
4. Re-derive implementation from the full requirement set, without refering existing code.
5. Compare with pre-existing implementation, list what are now stale (must be replaced or deleted).
6. Implement without anchoring stale design.

**Mindset**

Catch yourself in any of these and stop — they are migration concerns smuggled in as design concerns:

- "the current code does X, so the new design should look similar"
- "X is a pre-existing feature so it must survives"
- "we need to stay backward-compatible with X"
- "let's stick to the existing module boundaries / pattern / abstractions"
- "let's not be too aggressive / disruptive / far from what the team knows"
- "X is already wired up, so reuse it"
- "X is in codebase, so the user must still want it"

If a current pattern survives, it survives only when it is the sane answer when reasoned forward from requirements — not because it is already there.
