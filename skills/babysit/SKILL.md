---
name: babysit
description: >
  Run long-running tasks under babysit — supervised background runner with cgroup-enforced memory/CPU caps and observability-stall kill. Use BEFORE any task expected to run longer than 2 minutes, compute-intensive jobs (e.g. builds/benchmarks/renders/training), background work, or when the user says "run in background", "use babysit". This skill defines guardrails and the mandatory workflow, not just a how-to.
---

# babysit — Supervised Background Task Runner

## Setup

```bash
command -v babysit || (mkdir -p "$HOME/.local/bin" && install -m755 scripts/babysit.py "$HOME/.local/bin/babysit")
babysit ping || babysit daemon-start
```

Paths are relative to this skill's directory. If installation fails, call the self-contained `scripts/babysit.py` directly in place of `babysit`.

## When to Use

- Non-interactive long-running tasks expected to run for >2 minutes
- Compute-intensive tasks: per-task cgroup caps (mem ≤40%, cpu ≤90%) prevent runaway resource use
- Long-running tasks that must survive the agent session: daemon runs detached under user systemd

## When NOT to Use

- Short tasks (<2 minutes): run in the shell directly
- Interactive commands: use the tmux skill instead
- IO-bound tasks (e.g. web servers, async loops): babysit's scheduler won't help
- Lightweight (low CPU + low memory) tasks fine to die with the session: plain shell backgrounding

## Hard Guardrail — Don't Bypass

This skill is the cost guardrail for compute-intensive work on this host — not an optional tool. If a task is heavy (CPU-bound, memory-bound, multi-process), it MUST run under babysit so the cgroup caps and observability watchdog can stop runaway cost. Anti-patterns:

- **Routing heavy work through your harness's own background runner** (or a bare `&` / `nohup`) to dodge the queue → no one monitors footprint; the host can thrash and lock the user out of SSH.
- **Inflating `--estimated_mem_bytes` / `--estimated_cpu_cores`** to pass the soft-deny gate while you don't actually need the headroom → starves other tasks and defeats fair-scheduling.
- **Auto-backgrounded long Bash commands** (e.g. tools that fork into daemons): if they're heavy, `kill` and re-launch under `babysit run`.

When your task hits the resource cap, the first reflex is NOT to raise the limit. It is to:

1. Audit the script — profile, drop unused intermediates, rolling / partial read, subsampling, reduce space / time complexity, optimize nested loops, lower batch size / `n_jobs` / parallelism.
2. Re-run footprint-optimized; confirm the demand is genuinely unavoidable.
3. Only then raise estimates and `babysit wait_for_capacity` for moderation.

## Workflow

### 0. Smoke test

Before launching heavy work, smoke test on small scale for correctness and performance whenever appliable. Only proceed full-scale after the program is verified working and effcient in time and space.

### 1. Enqueue

```bash
babysit run \
  --name="<unique-name>" \
  --command="uv run python -u path/to/script.py" \
  --estimated_time="10m" \
  --estimated_mem_bytes="4G" \
  --estimated_cpu_cores=4
```

> Provide best-effort estimates for time, peak memory, and peak CPU cores — by extrapolation of smoke test (if linear complexity appliable) plus prior live experience (if any). Never over-estimate without clue (starves other tasks). You'll get a `runaway_risk` notification when any actual exceeds its estimate. Pick estimation wisely.

The call is non-blocking: returns immediately with `queued: <name>`. The daemon dispatches as soon as system has capacity.

Required: `--name` (unique), `--command` (single shell string). Optional: `--estimated_time` (default 10m), `--kill_timeout` (default 2× estimated), `--observability_interval` (default 5m), `--mem_pct_limit` (default 40), `--cpu_pct_limit` (default 90), `--estimated_mem_bytes` (default `4G`), `--estimated_cpu_cores` (default `4`), `--cwd` (default current shell cwd).

> Override the defaults to match your workload — under system memory/CPU pressure the daemon kills estimate-exceeders before within-estimate tasks, so accurate predictions protect long-running work. Hard kill fires at 2× sustained (daemon, graceful) or 3× instant via cgroup OOM. If the pressure is caused by an external (non-babysit) process — when the sum of all managed tasks' usage is smaller than the excess over threshold — the daemon logs and skips the kill rather than punishing its own tasks for someone else's load.
>
> If capacity is tight, `babysit run` may soft-deny with `capacity_exceeded` (exit 2, JSON on stderr) — run the `babysit wait_for_capacity --mem_bytes=… --cpu_cores=…` (blocks until room exists) to wait for room, reduce estimates, or pass `--force` to override.

### 2. Wait for completion

```bash
babysit wait --name="<unique-name>"
```

This blocks until the task ends. If your harness can run a command in the background and notify you on exit, launch the wait that way and go idle; otherwise block on it in the foreground. Either way you get:

- a mid-flight `{"event":"runaway_risk","dim":"elapsed|mem|cpu", ...}` JSON line on stderr the first time an actual exceeds its declared estimate (elapsed > `estimated_time`, mem > `estimated_mem_bytes`, or cpu_cores > `estimated_cpu_cores`) — inspect the log and decide whether to keep waiting or `babysit kill`. Daemon hard-kills for mem/cpu at 2× sustained for the monitor tolerance window; elapsed hard-kills at `--kill_timeout` (default 2× `estimated_time`).
- a terminal-status JSON object on stdout when the task reaches a terminal state (exit 0 only on `completed`; exit 1 for everything else — `failed`, `killed`, `unknown`). For a kill, `kill_reason` + `kill_hint` fields at the top of the JSON tell you what to fix.

**Never poll in a sleep loop** (`sleep 60 && babysit status/log ...`) — it burns turns and tells you nothing the daemon doesn't already push. `babysit wait` is the only correct way to await a task. This rule is mandatory even on harnesses where no hook enforces it.

**NEVER poll indefinitely** (`babysit log`; `babysit log`; ...) — it consumes LLM tokens rapidly. Instead use `babysit wait` to wait until a task finish.

### 3. Check log / progress at any time

```bash
babysit log --tail=15 --name="<unique-name>"  # quick peek at log
babysit log --follow --name="<unique-name>"   # stream; run it backgrounded, it never returns on its own
```

### 4. List / kill / adjust

```bash
babysit list                           # running/pending + terminal ended within 24h; --all for full history
babysit status --name="<name>"         # one task, JSON
babysit kill --name="<name>"           # SIGTERM, then scope-stop fallback
babysit adjust --name="<name>" --estimated_mem_bytes=32G  # retune estimated peak memory
```

## The Observability Contract

babysit **kills tasks that go silent** for longer than `observability_interval` (default 5m). Your command MUST print at least one line every 5 minutes. Use:

- `PYTHONUNBUFFERED=1` (or `python -u`) to defeat block-buffering
- Periodic progress markers with real signal: `[3/42] ETA ~3m loss=1.2e-4`
- LightGBM / native C++ stdout under pipes: write a custom Python callback with `flush=True` — `lgb.log_evaluation` is silent under non-tty stdout
- Generic keep-alives (`Keep-alive`, `heartbeat`, dots) defeat the purpose; emit progress, not noise

## Conversation Example

<example>
<user-msg>Start training in the background.</user-msg>
<assistant-msg>
```bash
babysit run --name=train-maker-200t \
  --command='PYTHONUNBUFFERED=1 uv run python -u src/train_maker_twohead.py' \
  --estimated_time=2h
babysit wait --name=train-maker-200t   # backgrounded if the harness supports it, else blocking
```
Training enqueued; will report on completion.
[STOP AND WAIT — no sleep-poll loop]
</assistant-msg>
<system-msg>~2h later: the wait command exits 0.</system-msg>
<assistant-msg>
[`babysit log --tail=40 --name=train-maker-200t` to inspect final metrics]
Training complete. Sharpe 2.74, AR 20.55%.
</assistant-msg>
</example>

## Pitfalls

### `babysit status` showing `completed` does NOT guarantee success

Exit code 0 ≠ success when the inner runner swallows errors. A `just <recipe>` whose inner step fails with exit 1 may still return 0 to babysit. Always verify expected output files exist before chaining downstream tasks.

### Bash-wrapper double-quoting

`--command` is passed to `bash -c` internally. Do NOT nest a `bash -c '...'` inside:

```bash
# WRONG — bash -c sees only "VAR=1"
babysit run --name=x --command="bash -c 'VAR=1 uv run python -u s.py'"

# RIGHT
babysit run --name=x --command="VAR=1 uv run python -u s.py"
```

### Unbuffered Python under `uv`

`uv run -u` is rejected (`-u` flag goes to uv, not python). Use either:

```
PYTHONUNBUFFERED=1 uv run python script.py
uv run python -u script.py
```

### Native C++ stdout is unaffected by `PYTHONUNBUFFERED`

LightGBM, XGBoost, sklearn's joblib workers, etc. write to stdout from C/C++ and ignore Python's buffering. Under babysit's pipe stdout, the native iter-loggers appear silent and the observability watchdog will kill the task. Wrap with a Python callback that reads metrics and prints with `flush=True`.

### `babysit ping` failure means daemon is down

If commands return `babysit daemon not running`, run `babysit daemon-start`. One-time setup per host: `loginctl enable-linger $USER` so the daemon survives logout.

### Names must be unique across active tasks

`babysit run` rejects a name that matches an existing non-terminal task. Pick descriptive names (`maker-cv-200t-2026-05-19`), or `babysit kill` the prior one first.

## Skill Files

- `references/babysit.md` — full babysit spec (CLI flags, daemon config, resource rules)
- `hooks/no-sleep-babysit.sh` — blocks the `sleep N && babysit log/status` anti-pattern (only on harnesses with tool hooks; elsewhere the rule is on you)
- `scripts/babysit.py` — self-contained babysit implementation (installed to `~/.local/bin`)
