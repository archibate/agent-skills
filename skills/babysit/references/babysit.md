# Background Task Babysitting Rule

Every background running task must satisfies:

1. never consuming >40% system memory (recursively into child-process) -> optimize memory footprint
2. output at least one line of log every 5 minutes -> add observability logs
3. never consume >90% of CPU cores -> limit parallel number
4. elapsed more than 2x of prior estimated time -> suspect if task stuck

Kill immediately when one of above are violated, and follow the mitigation after `->`.

> Observability logs prevents blind of progress (look like stuck). The user care about progress and ETA, add metrics when appliable. Include progress tick like `[3/42]`, `ETA ~3m`, `loss=1e-4` in log entries. This helps diagnose issues mid-flight when a task is stuck or flaw. So that you can fix and restart flaw tasks immediately without having to wait for infinity for a stuck task before fixing. Avoid generic meanless `Keep-alive` prints against the intent of observability rule.


Keep monitoring system resource exhaustion risk:

1. system memory usage exceeds >70% -> kill top-memory task -> reduce memory footprint, avoid running multiple memory-consuming tasks in parallel
2. system disk usage exceeds >98% -> kill any disk writing task -> reduce disk footprint, wait for user to clean up space

Follow mitigation on violation for more than 30 consecutive seconds. Restart task after system usage dropped.

> System exhaust will cause constant ssh login failure, making user unable to use the computer. Memory runaway is the biggest sin, it make ssh process imposdible to spawn, and user will find their ssh stuck, unable to make any futher instructions to assistant. Optimize program memory footprint before re-run.


These rules can be enforced by running with the wrapper:
```bash
babysit run --name="some-heavy-task" --command="uv run python -u some_heavy_task.py" --estimated_time="10m"
# equivalant to:
babysit run --name="some-heavy-task" --command="uv run python -u some_heavy_task.py" --estimated_time="10m" --mem_pct_limit=40 --cpu_pct_limit=90 --kill_timeout="20m" --observability_interval="5m"
```

The `babysit run` is non-blocking, push into queue. Once started

> `-u` or `PYTHONUNBUFFERED=1` avoids python buffering stdout which can break observability rule.

Optionally declare peak-resource estimates so the daemon can (a) warn you mid-flight when actual exceeds your prediction and (b) treat your task fairly under system pressure:
```bash
babysit run --name="train-mlp" --command="uv run python -u train.py" --estimated_time="30m" --estimated_mem_bytes="4G" --estimated_cpu_cores=8
```

> `--estimated_mem_bytes` accepts `4G`, `512M`, `1.5T`, raw bytes (default `4G`). `--estimated_cpu_cores` is a float (default `4`). Override explicitly for heavy ML training, big-data scans, or single-threaded scripts — the defaults are tuned for a typical 10m task. Values exceeding host total RAM / cores are rejected at `babysit run` time.
>
> The spawned task inherits `POLARS_MAX_THREADS` / `OMP_NUM_THREADS` / `OPENBLAS_NUM_THREADS` / `MKL_NUM_THREADS` / `NUMEXPR_NUM_THREADS` defaulted to `max(1, round(estimated_cpu_cores))`, so Polars / OpenMP / BLAS thread pools stay within the declared CPU budget instead of spawning one thread per host core (the usual cause of `estimated_cpu_exceeded` kills on many-core hosts). A value set inline in the command (`POLARS_MAX_THREADS=16 …`) still wins. Raise `--estimated_cpu_cores` to widen both the cgroup quota and the thread pools together.
>
> `--cwd` (existing absolute path; default current shell cwd) is the task's working directory, shown as `PROJECT` in `babysit list` / `tui`.
>
> Soft warn at 1× (a `{"event":"runaway_risk","dim":"mem|cpu", ...}` line on `babysit wait` stderr — sanity-check on the fly). Hard kill at 2× sustained for the monitor tolerance window (default 30s) with `kill_reason="estimated_mem_exceeded"` / `"estimated_cpu_exceeded"`.
>
> Under system memory pressure, the daemon first checks whether killing managed tasks could actually relieve the excess: if the **sum of all running babysit tasks' usage** is smaller than the excess over threshold, the pressure is driven by an external (non-babysit) process and killing a managed task is collateral damage — the daemon logs `external process is the cause, skipping kill` and waits for the next tolerance-count window to re-check (typically the external process finishes on its own). Only when managed tasks can plausibly relieve the excess does victim selection proceed: pick by tier — (1) tasks exceeding their declared estimate first, (2) tasks with no declared estimate, (3) tasks within their estimate last. This protects sunk progress of well-behaved long-running tasks against runaway newcomers. The killed task's spawning agent reads `kill_reason="system_mem_pressure"` and should wait for system load to drop before retrying. System CPU is not enforced at the system level — babysit only governs its own tasks (see `max_babysit_cpu_pct` below) so external processes outside babysit's control can't trigger kills of managed tasks.
>
> Soft-deny on queue: `babysit run` checks two gates. Memory: `(total_ram - MemAvailable) + sum_of_pending_estimates + 2 × your_estimate ≤ max_sys_mem_pct × total_ram` (external memory counted — RAM exhaustion is catastrophic). CPU: `sum_of_running_babysit_cores + sum_of_pending_estimates + 2 × your_estimate ≤ max_babysit_cpu_pct × total_cores` (only babysit's own tasks counted). On deny, exits 2 with a `{"error":"capacity_exceeded","dim":"mem|cpu","projected_*","limit_*","hint","suggested_command":"babysit wait_for_capacity --mem_bytes=… --cpu_cores=…"}` JSON line on stderr. `babysit wait_for_capacity` runs the same check on a poll loop, emitting `{"event":"waiting_for_capacity","phase":"pressured|debounce", ...}` on stderr per poll. It only exits 0 after the gate stays open for a **random sustained window** in `[--debounce_min, --debounce_max]` (default 1–3 min) — desynchronizes concurrent waiters so they don't all race to `babysit run` the moment capacity opens; any pressure tick during the window resets it. Pass `--force` on `babysit run` to skip the gate entirely.

If babysit daemon not started:
```bash
babysit daemon-start
# equivalant to:
babysit daemon-start --max_sys_mem_pct=70 --max_sys_disk_pct=98 --max_babysit_cpu_pct=90 --monitor_interval="10s" --monitor_tolerance_count=3 --monitor_disk_infer_by_dir="$HOME"
```

> `babysit` monitors resource usage via psutil and kills violating processes. All spawned task processes run at lower priority (`nice +10`) so that the monitor thread stays responsive.

To show current tasks:
```bash
babysit list                              # default: running/pending + terminal ended within 24h
babysit list --since=7d                   # broaden the terminal window
babysit list --all                        # full history (every row)
# default expands to:
babysit list --columns="name,pid,status,kill_reason,kill_hint,kill_detail,exit_code,command,elapsed_time,estimated_time,kill_timeout,observability_interval,last_observed_log,time_since_last_observe,cpu_cores,cpu_pct,estimated_cpu_cores,mem_bytes,mem_pct,estimated_mem_bytes,disk_write_bytes,disk_read_bytes,num_procs,num_threads,cwd,claude_session_id" --format=json --since=24h
```

> `status` can be: pending, running, completed, failed, killed, unknown
>
> Terminal statuses are `completed` / `failed` / `killed` / `unknown`. For `killed`, `kill_reason` names the trigger (e.g. `manual`, `mem_exceeded`, `cpu_exceeded`, `estimated_mem_exceeded`, `estimated_cpu_exceeded`, `cgroup_oom_killed`, `kernel_oom`, `elapsed_exceeded`, `observability_stall`, `system_mem_pressure`/`system_disk_pressure`, `daemon_shutdown`) and `kill_hint` gives a one-line remediation. A plain `failed` exit (process returned non-zero on its own) has `kill_reason=null` — check `exit_code` instead. `failed`/`unknown` from daemon-restart or spawn corner cases do carry a `kill_reason` (e.g. `process_vanished`, `adopted_exited`, `daemon_restart_dead`, `spawn_error: …`).
>
> `kill_detail` (only populated for `system_mem_pressure` / `system_disk_pressure`) carries per-incident telemetry as a JSON object. Common keys: `dim`, `kill_time`, `system_pct`, `threshold_pct`, `sustained_seconds`, `victim_name`, `victim_tier`. Mem-dim adds: `victim_mem_bytes`, `victim_mem_pct`, `babysit_total_mem_bytes`, `babysit_total_mem_pct`, `top_external` (`{pid, name, mem_bytes, mem_pct}` for the highest-RSS process whose PID-tree is NOT under babysit — useful for diagnosing whether external load was the actual culprit when the external-cause shortcut didn't trip). Disk-dim adds: `disk_dir`, `disk_used_bytes`, `disk_total_bytes`, `victim_disk_write_bytes`.
>
> The cgroup envelope for memory is sized at `min(3 × --estimated_mem_bytes, --mem_pct_limit × total_ram)` (similar for CPU vs `os.cpu_count()`). An explosive allocation that outpaces the daemon's 30s soft-watch hits the kernel OOM boundary at 3× the declared estimate and is reported as `kill_reason="cgroup_oom_killed"` (distinct from the graceful `estimated_mem_exceeded`). A task that exits with code 137 (SIGKILL) without a cgroup-OOM trigger is reported as `kill_reason="kernel_oom"` — the system-wide kernel OOM killer chose it under host memory pressure; reduce footprint and re-queue.

To peek a task progress:

```bash
babysit status --name="<task name>"
# equivalant to:
babysit status --name="<task name>" --columns="..." --format=json
```

To wait until a task complete:

```bash
babysit wait --name="<task name>"
# equivalant to:
babysit wait --name="<task name>" --columns="..." --format=json
```

`wait` blocks until terminal status. stdout: single terminal-status JSON object. stderr: zero-or-more event JSON lines — `{"event":"runaway_risk","dim":"elapsed|mem|cpu", ...}` emitted once per dim when actual first exceeds the declared estimate. Background the wait if your harness can notify you on exit; otherwise let it block the foreground shell. Never sleep-poll `babysit status` instead.

To peek log:

```bash
babysit log --tail=15 --name="<task name>"
babysit log --head=15 --name="<task name>"
babysit log --full --name="<task name>" | rg ...
```

To re-tune an existing task's resource estimate without re-queueing:

```bash
babysit adjust --name="<task name>" --estimated_mem_bytes=32G
babysit adjust --name="<task name>" --estimated_cpu_cores=8
babysit adjust --name="<task name>" --estimated_mem_bytes=32G --estimated_cpu_cores=8
```

> `adjust` rewrites the task's `estimated_mem_bytes` / `estimated_cpu_cores` in the DB and, if the task is running, swaps the value into the in-memory `RunningTask` and resets the 2×-sustained overrun counter so the kill threshold restarts against the new estimate. Use after a `runaway_risk` warning when you've decided the new actual is acceptable and want to widen the kill cap (or, conversely, tighten it on a task you no longer trust). The cgroup `memory.max` set at launch (= `min(3 × estimate, mem_pct_limit × total_ram)`) is NOT re-applied to the running scope — re-queue if you need a tighter hard cap. Admission accounting for running tasks uses live RSS rather than the stored estimate, so adjusting a running task only retunes the kill threshold; it doesn't free admission headroom for new tasks. For pending tasks, the adjusted estimate is reflected in the next `_capacity_check`.

To stream log updates (it never returns on its own — background it):

```bash
babysit log --follow --name="<task name>"
```

you will be notified on log update.


For humans only (do not invoke from an agent), there is a `babysit tui` dashboard built on `textual` that renders the task list with live progress, sortable resource columns, log peek, and confirm-to-kill. Agent-facing subcommands above remain the API surface.


To purge stale finished tasks and their logs:

```bash
babysit clean                                        # default: purge terminal rows older than 24h + their log files
babysit clean --older_than=0s                        # purge all terminal rows immediately
babysit clean --status=killed,failed --dry_run       # preview without deleting
```

> The daemon also auto-purges terminal rows past `--cleanup_ttl` (default `7d`) once per minute on its tick loop, unlinking the corresponding `log_path` file. Override with `babysit daemon-start --cleanup_ttl=30d` etc.


## Surviving systemd-oomd slice kills

Ubuntu ships `systemd-oomd` with a default policy on `user@<UID>.service`:

```
ManagedOOMMemoryPressure=kill
ManagedOOMMemoryPressureLimit=50%
```

When PSI memory pressure on the user slice exceeds 50% sustained >20s with active reclaim, oomd SIGKILLs the entire `user@UID.service` slice — wiping the babysit daemon, dbus, every shell, every supervised task. The kill is at the *slice* layer above any cgroup `memory.max` babysit sets per task, so per-task caps are bypassed.

A common trigger: swap saturation combined with a fresh large allocation. Even when nominal RAM is free, every new alloc forces live-page reclaim instead of swap-out, spiking PSI.

To replace overbroad slice kill with targeted per-cgroup kernel-OOM (which respects babysit's `MemoryMax` + `MemorySwapMax=0`), install a drop-in:

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/oomd.conf <<'EOF'
[Service]
ManagedOOMMemoryPressure=auto
EOF
sudo systemctl daemon-reload
```

After this, only kernel OOM picks a victim. A runaway task hits its own cgroup `memory.max` and dies alone instead of taking the slice with it.

Trade-off: if cumulative memory truly exhausts RAM, kernel OOM still chooses by `oom_score`. With `MemorySwapMax=0` on babysit cgroups, an over-budget task gets cgroup-OOM'd before slice-wide pressure builds.


Use `babysit --help` or `babysit <subcommand> --help` for help.
