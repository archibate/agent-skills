---
name: pi-subagents
description: Delegate a self-contained survey or independent work to a background Pi subagent. Use to keep large exploration out of the main context, get a fresh-mind review, or run several directions in parallel.
compatibility: Pi
---

# Pi subagents

Run a subagent with the `job_start` tool. It captures the child's stdout/stderr, returns the job
directory, and notifies you when the child exits; read the result from the job's `stdout` file.
When `job_start` takes `sandbox`, pass `{"dangerouslySkipSandbox": true}`: the child is a full pi
that needs the network and its session files. Bound what it may do with `--permissions` (see
below), and keep the command a single `pi -p ...` so the bound is recognized.

## Start fresh

Start each new child with a fresh conversation. It loads its own project instructions and tools,
not the parent's conversation. Supply the task, relevant paths, constraints, and any findings it
needs; keep the handoff focused rather than copying the parent transcript.

Use a new `$PI_SESSION_ID.<name>` for each child. `--session-id` creates that session if absent
and resumes it if it already exists. `<name>` must end with a letter or digit.

```
job_start
  name:    review
  sandbox: {"dangerouslySkipSandbox": true}
  command: pi -p --session-id "$PI_SESSION_ID.review" --model "$PI_PROVIDER/$PI_MODEL" --thinking "$PI_REASONING_LEVEL" --permissions read-only "You are a subagent; do not spawn subagents. Task: review the unstaged changes in src/ for correctness. Do not edit files. Return concrete findings with file:line evidence."
```

`--model` and `--thinking` keep the child on your current model and effort; change them to give the
child a different one.

## Recursion

Delegate only from the main agent. Every child task starts with "You are a subagent; do not
spawn subagents." A task carrying that marker means you are the child: do not delegate further.

## Read-only and restricted children

`--permissions read-only` keeps the child's read-only bash and blocks any write, edit, or bash
grant. For a child that edits, pass a sandbox object instead, e.g.
`--permissions '{"writableLocations":["src"]}'`. For a handover file,
add its directory to `writableLocations`; the child's own scratchpad is a different directory.

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

For follow-up work on the same task, resume the child with its exact `--session-id`. This retains
the child's focused conversation; provider cache reuse is not guaranteed.

```
job_start
  name:    review-2
  sandbox: {"dangerouslySkipSandbox": true}
  command: pi -p --session-id "$PI_SESSION_ID.review" --permissions read-only "You are a subagent; do not spawn subagents. Task: also check the tests"
```

The child must have exited before resuming it; this does not steer a running one.

## Parallel and sequential

Issue several `job_start` calls in one message to run children in parallel; each notifies you on
exit. Keep parallel children read-only or editing disjoint files, otherwise run them one at a time.
For staged work, read one verdict before starting the next.
