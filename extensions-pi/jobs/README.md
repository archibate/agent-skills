# jobs

Explicit background jobs for pi, with the filesystem as the API. Replaces the old `background`
extension's auto-backgrounding.

`bash` stays native pi: foreground and timeout-gated, with no hidden second mode. This extension
only (1) injects a default timeout when the model omits one, so a forgotten long command cannot
hang forever, and (2) appends a `job_start` hint when that timeout fires. Long-running work goes
through `job_start`, which returns a job id and notifies the agent when the job exits.

## Tools

Only two tools are declared; everything else is the job's files on disk, operated with bash.

| Tool | Purpose |
|---|---|
| `job_start` | Run a command in the background; notifies on exit and returns the job's directory. |
| `job_watch` | Deliver matching stdout lines as messages instead of polling (needs the live runtime). |

`/jobs` lists the jobs this pi process knows about.

## The job directory

Each job gets an owner-only (0700) directory at `$TMPDIR/pi-jobs/<id>/`:

| File | Contents |
|---|---|
| `command` | the command line |
| `stdout` | stdout |
| `stderr` | stderr |
| `status` | status, written once the job finishes |
| `pgid` | process group |
| `started` | ISO 8601 start time |

The `pi-jobs` root is created sticky and world-writable (`1777`, like `/tmp`), so several users can
create their own job directories while only the owner of an entry may delete it. Each `<id>/` is
created `0700` and validated like scratchpad (rejecting a symlink, non-directory, another owner, or
group/other bits), so job output stays private even when `TMPDIR` is the shared `/tmp`.

Because they are plain files, bash composes them:

```bash
d="$TMPDIR/pi-jobs/<id>"
ls -la "$TMPDIR/pi-jobs"                      # list jobs
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

- Every job runs in its own process group with detached stdio; `$TMPDIR` is resolved per call, so
  logs follow the scratchpad (and any later `TMPDIR` change).
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
- A job with no `timeout` that never finishes will hold a one-shot run open indefinitely; kill it
  (`kill -- -<pgid>`) or pass `timeout` when starting it.

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
