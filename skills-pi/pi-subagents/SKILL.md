---
name: pi-subagents
description: Delegate a self-contained survey or independent work to a background Pi subagent. Use to keep large exploration out of the main context, get a fresh-mind review, or run several directions in parallel.
compatibility: Pi
---

# Pi subagents

Run a subagent with the `job_start` tool. It captures the child's stdout/stderr, returns the job
directory, and notifies you when the child exits; read the result from the job's `stdout` file.
When `job_start` takes `sandbox`, pass `{"dangerouslySkipSandbox": true}`: the child is a full pi
that needs the network and its session files, and it sandboxes its own commands.

## Fork or fresh

**Fork** continues your session: it inherits your context and reuses the prompt cache. State only
what to do, and leave the system prompt, tools, model, and thinking level unchanged.

```
job_start
  name:    review
  sandbox: {"dangerouslySkipSandbox": true}
  command: pi -p --fork "$PI_SESSION_ID" --session-id "$PI_SESSION_ID.review" "You are a forked subagent; do not spawn subagents. Task: review the unstaged changes"
```

**Fresh** starts empty. Put everything the child needs in the task. It is only empty if its
`<name>` is new: `--session-id` continues an existing id, so pick a fresh name per task.

```
job_start
  name:    audit
  sandbox: {"dangerouslySkipSandbox": true}
  command: pi -p --session-id "$PI_SESSION_ID.audit" --model "$PI_PROVIDER/$PI_MODEL" --thinking "$PI_REASONING_LEVEL" --append-system-prompt "You are a subagent; do not spawn subagents." "Audit src/ for security issues and report findings"
```

`--model` and `--thinking` keep the child on your current model and effort; change them to give the
child a different one. Fork when your context already holds the relevant observations or the
background is long to restate; fresh when a new perspective is the point or the task is
self-contained.

## Recursion

Delegate only from the main agent. Every child task starts with "You are a ... subagent; do not
spawn subagents." A task carrying that marker means you are the child: do not delegate further.

## Read-only and restricted children

Pass `--sandbox-ceiling read-only`: the child keeps read-only bash, and any write, edit, or bash
grant is blocked. It works with `--fork`, since it does not change the prompt. To bound a child
that edits, pass a sandbox object instead, e.g. `--sandbox-ceiling '{"writableLocations":["src"]}'`.
For a handover file, add its directory to the ceiling's `writableLocations`; the child's own
scratchpad is a different directory.

## Results

`job_start` returns the job directory; you are notified when the child exits.

```bash
d="<job dir>"
cat "$d/stdout"   # the child's final text
cat "$d/status"   # the exit status
```

Use `job_watch` to receive matching `stdout` lines while you keep working. For a long report, give
the child a handover path in your scratchpad in the task, and read that file instead of `stdout`.

## Follow-ups

`--session-id "$PI_SESSION_ID.<name>"` gives the child a deterministic, parent-scoped id. Resume it
later with the same handle; the turn is appended to the same session, so context and prompt cache
are reused.

```
job_start
  name:    review-2
  sandbox: {"dangerouslySkipSandbox": true}
  command: pi -p --session "$PI_SESSION_ID.review" "You are a subagent; do not spawn subagents. Task: also check the tests"
```

`<name>` must end with a letter or digit. `--fork` refuses an id that already exists, so pick a
fresh name per child; without `--fork`, an existing id is continued instead. Resume is not live:
the child must have exited, and you cannot steer a running one.

## Parallel and sequential

Issue several `job_start` calls in one message to run children in parallel; each notifies you on
exit. Keep parallel children read-only or editing disjoint files, otherwise run them one at a time.
For staged work, read one verdict before starting the next.

## Guardrails

- With `--fork`, do not pass `--append-system-prompt`, `--tools`, `--model`, or `--thinking`; they
  invalidate the cache and the fork's advantage.
