---
name: opus-advisor
description: >
  Consult an independent read-only Claude Opus advisor when the consequence of being wrong and the remaining uncertainty make a second judgment worthwhile, including before committing to a material decision or completion claim. Opus challenges Codex's reasoning and evidence; Codex retains responsibility for edits and the final judgment.
---

# Opus Advisor

Use a fresh Opus context as an independent advisor. Opus inspects the project and returns its evidence, domain knowledge, objections, and verification demands; Codex performs the edits and owns the conclusion.

## Choose one mode

- `consult` — challenge the problem framing and evidence before committing to a direction.
- `review` — challenge work in progress or its correctness argument.
- `gate` — challenge the finished work and verification evidence before claiming completion.

Combine overlapping needs into one call. For example, one `gate` call can cover correctness verification and the final audit.

## Prepare the request

Run the launcher from the project under review:

```bash
<skill-directory>/scripts/ask-opus <consult|review|gate> '<request>'
```

Resolve `<skill-directory>` from this loaded `SKILL.md`; do not assume the skill is inside the current project.

The launcher grants read tools host-wide access and confines Bash writes to an ephemeral scratch directory with network access blocked. It removes that directory after the call and times out after 900 seconds by default; set `OPUS_ADVISOR_TIMEOUT_SECONDS` when a different bound is justified.
Progress is streamed to stderr; stdout contains only the final advisory report.

Host-wide reads can expose source and system files to Claude. Do not invoke the advisor where that visibility to the model provider is unacceptable.
Any tool permission denial invalidates the advisory call; the launcher fails closed instead of returning a partial report.

Give Opus:

- the goal and success criteria;
- relevant constraints and artifact paths;
- the candidate decision, plan, or implementation when one exists;
- commands and observed results already used as evidence;
- any context that exists only in the Codex conversation;
- the precise uncertainty or verdict requested.

Ask open questions when seeking tacit domain knowledge. Avoid seeding the expected answer. Let Opus inspect the workspace instead of pasting a large synthetic summary when the evidence is locally available.

## Integrate the advice

Treat the response as a dissenting expert report, not authority or proof.

- Verify workspace claims against files, logs, or measurements.
- Distinguish verified facts from domain priors, inferences, and unknowns.
- Investigate every material `REVISE` or `BLOCK` finding. Fix it or establish contrary evidence, then rerun the relevant review.
- Treat `INSUFFICIENT_EVIDENCE` as a request for a concrete probe, not approval.
- Keep edits and implementation in Codex. Opus must return all useful guidance in its response.

For a completion gate, start a fresh call after implementation and tests. Include the final diff scope, verification commands and results, and known limitations. An `APPROVE` verdict is advisory input; Codex still needs independent evidence that the requested goal is satisfied.

If the launcher cannot run, report that the advisor was unavailable. Do not fabricate an advisory verdict.
