# Session scratchpad

Sets `TMPDIR` to `${XDG_CACHE_HOME:-~/.cache}/pi/scratchpad/<session-id>/`
and adds a short system-prompt guideline showing the resolved absolute path for
file tools and advertising `"$TMPDIR"` as the bash shortcut. Relative or empty
`XDG_CACHE_HOME` values use `~/.cache`.

Run `/reload` after installing, then `/scratchpad` to show the current location.
Shell commands can use `"$TMPDIR"` directly. `read`/`write`/`edit` do not expand
environment variables; use the absolute scratchpad path shown in the prompt.

## Behavior

- New sessions and forks get separate directories. Reloading/resuming reuses the
  same directory; forks do not copy scratch files from their parent.
- Scratchpad directories are owner-only (`0700`). Existing symlinked app/session
  directories, unsafe permissions, or unwritable directories are rejected. A
  symlinked cache home is allowed after validating its resolved target.
- Sets the Pi process's environment rather than replacing tools, so existing tool
  executors keep working. Shell children and Pi's dynamically allocated overflow
  logs inherit the new temporary location. Tools that cache their temporary
  location during module loading can retain the old location.
- Restores the previous `TMPDIR` on session teardown, unless another component
  has since changed it. The working directory is unchanged.
- Initialization failure is reported and blocks `bash`, `powershell`, `monitor`,
  and user `!` commands until the configuration is fixed and Pi is reloaded.
  File tools remain available to inspect/repair the problem.

Files are retained indefinitely; there is no automatic deletion or size quota.
Only put disposable data here, and remove inactive session directories when no
process needs them. This is a convention, not filesystem confinement: explicit
`/tmp` writes are still possible. The extension assumes one active Pi session per
process (the CLI); it is not intended for concurrent in-process SDK sessions.

## Verification

Unit tests use isolated cache fixtures and restore the environment:

```bash
node --test ~/.pi/agent/extensions/scratchpad/tests/scratchpad.test.mjs
```

The offline integration test exercises the installed Pi runtime and the jobs
extension without making model requests. Set `PI_SDK_PATH` to the Pi
release's `dist/index.js`, for example:

```bash
PI_SDK_PATH="$HOME/.pi/agent/install/releases/0.99.1/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
  node --test ~/.pi/agent/extensions/scratchpad/tests/integration.test.mjs
```

Without `PI_SDK_PATH`, the integration test is skipped. Tests require Node's
TypeScript stripping support and POSIX filesystem/shell behavior.
