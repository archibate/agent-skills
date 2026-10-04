# jobs

Explicit background jobs for pi, with the filesystem as the API. Replaces the old `background`
extension's auto-backgrounding.

`bash` stays native pi: foreground and timeout-gated, with no hidden second mode. This extension
(1) injects a default timeout when the model omits one, so a forgotten long command cannot hang
forever, (2) appends a `job_start` hint when that timeout fires, and (3) holds one-shot (print/JSON)
runs open while jobs are pending, nudging the agent on a per-job liveness backoff so a job that
never exits surfaces for a heal-or-kill decision instead of hanging the run. Long-running work goes
through `job_start`, which returns a job id and notifies the agent when the job exits.

## Tools

Only two tools are declared; everything else is the job's files on disk, operated with bash.

| Tool | Purpose |
|---|---|
| `job_start` | Run a command in the background; notifies on exit and returns the job's directory. |
| `job_watch` | Deliver matching stdout lines as messages instead of polling (needs the live runtime). |

`/jobs` lists the jobs this pi process knows about.

## The job directory

Each job gets an owner-only (0700) directory at `$XDG_RUNTIME_DIR/pi-jobs/<id>/`:

| File | Contents |
|---|---|
| `command` | the command line |
| `stdout` | stdout |
| `stderr` | stderr |
| `status` | status, written once the job finishes |
| `pgid` | process group |
| `started` | ISO 8601 start time |

The root sits inside `$XDG_RUNTIME_DIR`, which the system already creates per-user, owner-only,
and clears at logout, so job output is private by inheritance and the root needs no
sticky/world-writable mode. Only the `pi-jobs` root and each `<id>/` are created `0700`; an existing
symlink or foreign owner is rejected. Where `XDG_RUNTIME_DIR` is unset (macOS, minimal containers),
the root falls back to a uid-scoped `$TMPDIR/pi-jobs-<uid>`.

Because they are plain files, bash composes them:

```bash
d=<job dir printed by job_start>
ls -la "$(dirname "$d")"                      # list jobs
cat "$d/command"                              # what it ran
cat "$d/started"                              # when it started
grep -i error "$d/stdout"                     # search output
tail -f "$d/stdout"                           # follow output
until [ -e "$d/status" ]; do sleep 1; done; cat "$d/status"   # wait for it
kill -- -"$(cat "$d/pgid")"                    # SIGTERM the group; -9 to force
```

`job_start` returns its directory, and the files inside follow this layout, so a model with bash
can run a job end-to-end without extra tool schemas.

## Behavior

- Every job runs in its own process group with detached stdio; the jobs root is resolved per call
  from `$XDG_RUNTIME_DIR`, independent of `TMPDIR` and the scratchpad.
- The process-global registry lives on `globalThis`, so live jobs survive `/reload`; the newest
  extension load owns notification delivery. On forced exit (SIGTERM, crash) live jobs are killed
  and the files this process created are removed; a graceful one-shot run waits for them instead.
- Completion is delivered with `pi.sendMessage({triggerTurn: true, deliverAs: "steer"})`, so it
  arrives while the agent keeps working or wakes it after the turn ends. In one-shot modes
  (print/JSON) the run holds before settling while jobs are pending, so completion is delivered as
  a continuation turn instead of being lost to process exit. `job_watch` replays the last 20 lines
  (the seed), then follows from there, batches lines, and stops on flood, timeout, or job exit;
  while a watch is live it owns the job's exit notification, so the generic completion summary is
  suppressed for that job.
- `bash` default timeout: `PI_JOBS_BASH_TIMEOUT_SECONDS` (default 120, `0` disables). The timeout
  error points the model at `job_start`.
- Liveness heartbeats: while a one-shot run is held open, each running job is revisited on a
  per-job backoff (default 2 min after start, doubling to 1 h) with a nudge listing its elapsed
  time and stdout/stderr size and age, so the agent can tail, heal, or kill it. Being per job, a
  freshly started job is checked long before an old one. `PI_JOBS_HEARTBEAT_SECONDS` sets the base
  (default 120, `0` disables). Heartbeats run only in one-shot modes, where the process would
  otherwise not wait.
- A job with no `timeout` that never finishes still holds a one-shot run open, but the liveness
  heartbeat keeps surfacing it so the agent can heal or kill it instead of hanging silently. Pass
  `timeout` when starting a job to bound it without agent intervention.

## Editor setup

`tsconfig.json` type checks `index.ts` and `jobs.ts` under strict settings. The host packages
(`@earendil-works/pi-coding-agent`, `typebox`, `@types/node`) are symlinked into `node_modules` so
tsc and tsserver can resolve them; pi itself aliases those imports, so the links are editor-only.
Refresh them after a pi upgrade, which moves the release directory:

```bash
just link   # point node_modules at the current release
just check  # npx tsc --noEmit
```

## Verification

Engine unit tests need no pi install:

```bash
node --test ~/.pi/agent/extensions/jobs/tests/jobs.test.mjs
```

The tool-layer integration test uses the installed pi runtime and makes no model requests. Set
`PI_SDK_PATH` to the Pi release's `dist/index.js`:

```bash
PI_SDK_PATH="$HOME/.pi/agent/install/releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
  node --test ~/.pi/agent/extensions/jobs/tests/integration.test.mjs
```

Tests require Node's TypeScript stripping support and POSIX process behavior.
