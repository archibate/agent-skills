# Progressive Revealing

Splitting a prompt that outgrew the instruction budget: a lean entry always in context, plus detail loaded on demand.

Skills are the very example: `SKILL.md` carries the triggers and the decision rules, `references/*.md` carries the long tail. Agent-facing docs for big project knowledge follow the same tree hierarchy.

Split on decide-vs-execute, not on topic size: the entry holds what the model needs to *choose* an action, the reference holds what it needs to *perform* the action once chosen. A model that already decided can afford one more read; a model that never learns the branch exists can't.

Each pointer must states its load condition, e.g. `Read references/profiling.md before profiling or benchmarking`. A reference the model never learns to load is dead weight, not saved budget - the load condition is what turns it into saved budget.

One level of depth is usually enough. Deeper trees cost a read per level before the model reaches the content, and the entry starts spending budget describing its own tree.

**Why:** Only the entry competes for instruction budget; the rest arrives already scoped to a decision the model has made, and reduces attention dilution for tasks that never touch it.
