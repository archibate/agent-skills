# Progressive Disclosure

Provide information when it becomes relevant to the agent's next decision. Keep what is needed to choose and correctly start an operation available before the call; deliver condition-specific diagnostics, recovery, and next steps when the condition occurs.

Use reference files for detail selected by the task, and runtime results for guidance selected by actual outcomes. This applies to MCP tools, skill-local scripts, and CLIs.

## Reference files

Keep a lean entrypoint in context and load detailed guidance on demand.

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

## Tool, script, and CLI results

For failures detected reliably at runtime, return the relevant cause and feasible recovery in the error message. Avoid preloading an inventory of possible errors and remedies. Successful results can also provide a next-step hint when it becomes relevant.

Make each response self-contained for its outcome: state what failed or completed, any known side effects or execution uncertainty, and the next useful action. Preserve machine-readable status fields where consumers need them. For example, a missing-file result can say: "File not found; list the directory and select an existing file." The agent need not learn that recovery rule before seeing the failure.

Before removing static recovery guidance, verify that the actual consumer receives the replacement message through the tool response, captured stdout/stderr, or an asynchronous result it reads. An exit code alone or a diagnostic hidden in logs cannot replace that guidance. Exercise the affected result paths to check delivery.

Before invocation, explain operation semantics and material side effects. Let cheap, side-effect-free validation errors explain input-format details.
