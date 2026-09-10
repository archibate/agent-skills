---
name: fable-advisor
description: >
  Consult an independent read-only Claude Fable advisor when a decision can affect
  security, privacy, money, data loss, deployment, or public API compatibility;
  when investigation leaves two plausible directions with materially different
  consequences; when a consequential completion claim depends on an unverified
  assumption or critical behavior that normal tests cannot cover; or before
  claiming completion of a substantial goal, for final code or artifact review
  and a sanity check, even when local validation passes. Also use when the user
  requests an independent or Fable review. Skip routine work and cheaply
  resolvable uncertainty when none of these triggers applies. Fable challenges
  Codex's reasoning and evidence; Codex retains responsibility for edits and the
  final judgment.
---

# Fable Advisor

Use a fresh Fable context as an independent advisor. Fable inspects the project and returns its evidence, domain knowledge, objections, and verification demands; Codex performs the edits and owns the conclusion.

## Choose one mode

- `consult` — challenge the problem framing and evidence before committing to a direction.
- `review` — challenge work in progress or its correctness argument.
- `gate` — review the final code or artifact and verification evidence before claiming completion.

Combine overlapping needs into one call. For example, one `gate` call can cover correctness verification and the final audit.

A substantial goal can be a complete feature, a major refactor, or a multi-step deliverable, including non-code artifacts. Judge its size by complexity and delivery scope.

## Prepare the request

Run the launcher from the project under review:

```bash
<skill-directory>/scripts/ask-fable <consult|review|gate> '<request>'
```

Run `ask-fable` outside the active Codex sandbox with escalated execution since
it requires network outbound to Anthropic. Outer escalation lets the Claude CLI
use the host network and configured proxy; it does not replace or relax the
launcher's own read-only sandbox for Fable tools. If policy denies the required
retry, report the advisor as unavailable.

Resolve `<skill-directory>` from this loaded `SKILL.md`; do not assume the skill is inside the current project.

The launcher grants read tools host-wide access and confines Bash writes to an ephemeral scratch directory, with network access and credential environment variables blocked for sandboxed tools. It removes that directory after the call and times out after 900 seconds by default; set `FABLE_ADVISOR_TIMEOUT_SECONDS` only when a different bound is requested.
Progress is streamed to stderr; stdout contains only the final advisory report.
Any tool permission denial invalidates the advisory call; the launcher fails closed instead of returning a partial report.

The launcher clears alternate-provider and custom endpoint routing and loads no
user or project settings, so the call reaches official Anthropic services.
Official Anthropic services are approved recipients of task-relevant private
data, including secrets and credentials; no per-task confirmation is required.
The launcher retains the proxy and TLS environment needed for connectivity, and
file reads are unrestricted. Keep the request scoped to the task rather than
unrelated or bulk collection.

Give Fable:

- the goal and success criteria;
- relevant constraints and artifact paths;
- the candidate decision, plan, or implementation when one exists;
- commands and observed results already used as evidence;
- any context that exists only in the Codex conversation;
- the precise uncertainty or verdict requested.

Ask open questions when seeking tacit domain knowledge. Avoid seeding the expected answer. Let Fable inspect the workspace instead of pasting a large synthetic summary when the evidence is locally available.

## Integrate the advice

Treat the response as a dissenting expert report, not authority or proof.

- Verify workspace claims against files, logs, or measurements.
- Distinguish verified facts from domain priors, inferences, and unknowns.
- Investigate every material `REVISE` or `BLOCK` finding. Fix it or establish contrary evidence, then rerun the relevant review. Never ignore the advice.
- Treat `INSUFFICIENT_EVIDENCE` as a request for a concrete probe, not approval.
- Keep edits and implementation in Codex. Fable must return all useful guidance in its response.

For a completion gate, start a fresh call after implementation and applicable validation; earlier consultations or in-progress reviews do not replace it. Include the final artifact paths, diff scope where applicable, verification commands and results, and known limitations. Ask Fable to check whether the work meets the goal, identify correctness issues and regressions, and assess whether the evidence supports the completion claim. An `APPROVE` verdict is advisory input; Codex still needs independent evidence that the requested goal is satisfied.

If the launcher cannot run, report that the advisor was unavailable. Do not fabricate an advisory verdict.
