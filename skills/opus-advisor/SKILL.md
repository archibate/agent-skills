---
name: opus-advisor
description: >
  Consult an independent read-only Claude Opus advisor when a decision can affect
  security, privacy, money, data loss, deployment, or public API compatibility;
  when investigation leaves two plausible directions with materially different
  consequences; or when a consequential completion claim depends on an
  unverified assumption or critical behavior that normal tests cannot cover.
  Also use when the user requests an independent or Opus review. Skip routine
  edits and uncertainty that local inspection, documentation, or tests can
  resolve cheaply. Opus challenges Codex's reasoning and evidence; Codex retains
  responsibility for edits and the final judgment.
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

Run `ask-opus` outside any active Codex sandbox; request escalated execution for
the launcher command. Outer escalation lets the Claude CLI use the host network
and configured proxy. It does not replace or relax the launcher's own read-only
sandbox for Opus tools. If policy denies outer escalation, report the advisor as
unavailable.

Resolve `<skill-directory>` from this loaded `SKILL.md`; do not assume the skill is inside the current project.

The launcher grants read tools host-wide access and confines Bash writes to an ephemeral scratch directory with network access blocked. It removes that directory after the call and times out after 900 seconds by default; set `OPUS_ADVISOR_TIMEOUT_SECONDS` when a different bound is justified.
Progress is streamed to stderr; stdout contains only the final advisory report.

Host-wide reads can expose source and system files to Claude. Do not invoke the advisor where that visibility to the model provider is unacceptable.
Any tool permission denial invalidates the advisory call; the launcher fails closed instead of returning a partial report.

External disclosure must be authorized by the active execution policy or the
user; this skill does not grant that approval. When official Anthropic services
are an approved recipient, this resolved launcher is a subset of that
provider-level trust. Keep secrets out of the request text and do not direct
Opus to credential stores: the launcher clears alternate-provider and custom
endpoint routing, denies credential environment variables to sandboxed tools,
but does not restrict file reads. It retains standard proxy and TLS environment
settings needed for host connectivity; those settings remain part of the
disclosure boundary.

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
