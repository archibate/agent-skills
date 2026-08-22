# Progressive Disclosure

Split a prompt that has outgrown the instruction budget into a lean entrypoint that is always in context and details that are loaded on demand.

Skills provide a clear example: `SKILL.md` carries the triggers and decision rules, while `references/*.md` carries the long tail. Agent-facing docs for extensive project knowledge follow the same tree hierarchy.

Split on decide versus execute, not on topic size: the entry holds what the model needs to *choose* an action, while the reference holds what it needs to *perform* that action. A model that has already made the decision can afford one more read; a model that never learns that the branch exists cannot.

Each pointer must state its load condition, for example: "Read `references/profiling.md` before profiling or benchmarking." A reference that the model never learns to load is dead weight, not saved budget—the load condition is what turns it into saved budget.

One level of depth is usually enough. Deeper trees cost a read per level before the model reaches the content, and the entry starts spending budget describing its own tree.

**Why:** Only the entry competes for the initial instruction budget; the rest arrives already scoped to a decision the model has made, reducing attention dilution for tasks that never use it.

Use skill-relative paths for bundled resources, such as `references/page.md`. Do not hard-code the skill's absolute location.

When a skill bundles an executable entrypoint, place it in `scripts/`, make it executable, and show agent-run commands using its skill-relative path:

```bash
scripts/executable --help
```

**Why:** Absolute paths are verbose and non-portable; the agent can resolve a skill-relative path when executing the command.

For large lookup tables, tell the agent to search the relevant reference by keyword instead of reading it end to end. Keep the table search-friendly; for example: "Search `references/routes.md` with `rg` for the relevant route or keyword."
