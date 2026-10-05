# sandbox

Runs the agent's `bash` (and `job_start`, and `/btw`'s bash) inside bubblewrap plus Landlock,
with the access each command needs declared in the tool call. The declaration is rendered under
the command, so a reviewer sees what every call asked for, and plain read-only calls stay terse.

Stage 1 grants whatever is declared. Review gating (`/permission`, pre-approved access, the
approval modal) is planned on top of the same declaration.

## Declaration

`bash` takes an optional `sandbox` object; `job_start` takes the same object but declares only a
one-line reference to `bash`'s, so the schema is in the prompt once. Raw values are validated at
run time either way. Omitted, a command runs read-only:

| Field | Default | Grant |
|---|---|---|
| `writableLocations` | none | Paths made writable; missing ones are created as directories. `/` is refused. |
| `networkAccess` | `disable` | `fetch-only`: HTTP(S) via a per-call proxy, local/private destinations refused. `full`: host network. |
| `socketAccess` | none | Host Unix sockets (or directories of them) the command may connect to. |
| `sessionBusAccess` | `false` | Session and system D-Bus. |
| `displayAccess` | `false` | Wayland, XWayland, X11 path sockets, `NIRI_SOCKET`, display variables. |
| `processAccess` | `visibility` | `disable`: own PID namespace. `signalling`: may signal host processes; background processes may outlive the command. |
| `deviceAccess` | `none` | `gpu`: `/dev/dri`, `/dev/nvidia*`. `full`: all of `/dev`. |
| `dangerouslySkipSandbox` | `false` | Run on the host, unsandboxed. |

The badge shows each grant; escape-grade grants (full network, sockets, D-Bus, display,
signalling, full devices, unsandboxed) are highlighted as warnings.

## What the default sandbox enforces

- **Filesystem**: the root is bound read-only. Writable: the session scratchpad
  (`PI_SCRATCHPAD_DIR`), a private 4 GiB tmpfs on `/var/tmp` exported as `TMPDIR`/`TMP`/`TEMP`,
  and declared locations. `/tmp` is the host's, readable but not writable. Inside a writable
  repository root, `.git/hooks` and `.git/config` stay read-only, so a command cannot plant code
  that later runs outside the sandbox.
- **IPC**: a read-only bind does not stop `connect()` on a Unix socket, so the entry point
  `landlock-exec` denies connecting to any Unix socket created outside the sandbox, pathname
  (`LANDLOCK_ACCESS_FS_RESOLVE_UNIX`) or abstract (`LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`), except
  granted ones. This closes tmux/nvim/wezterm/kitty remote control, D-Bus (`systemd-run --user`),
  X11, and agent daemons' sockets, including under `full` network. Sockets the command creates
  itself work normally.
- **Network**: own network namespace unless `full`. `fetch-only` runs `socat` inside to relay
  `127.0.0.1:3128` to the per-call proxy on a Unix socket; proxy variables point there and
  `NODE_USE_ENV_PROXY=1` is set. The proxy chains to the host's `http(s)_proxy`, honoring
  `no_proxy`, refuses loopback/private/link-local/multicast destinations (including names that
  resolve to them), and records destinations in the result's `details.sandbox.network`. It does
  not inspect HTTPS, so request methods are not enforced: `fetch-only` declares intent, the proxy
  only contains where traffic goes. The systemd-resolved socket is allowed only with `full`, so a
  network-less sandbox cannot resolve (and leak through) DNS.
- **Processes**: host PID namespace with `LANDLOCK_SCOPE_SIGNAL`: `ps` and `/proc` see host
  processes (command lines included), but signals to them fail, and ptrace-gated files such as
  `/proc/<pid>/environ`, `mem`, and `fd` links are denied. When the shell exits, its process group is killed, so
  background processes end with the command (a process that calls `setsid` escapes the group but
  stays sandboxed). Use `job_start` for long-running work and `job_stop` to stop it.
- **Environment**: display, D-Bus, and IPC variables (`SSH_AUTH_SOCK`, `TMUX`, `NVIM`,
  `KITTY_LISTEN_ON`, ...) are removed unless granted; `PI_SANDBOX=1` marks the sandbox. API keys
  and other variables are passed through.
- **Always**: `--die-with-parent`, own IPC/UTS/cgroup namespaces, all capabilities dropped.

Failure recovery is surfaced through results: a failing command whose output shows a read-only
filesystem, missing network, display, or D-Bus gets a one-line hint naming the field to declare.

## Ceiling for headless runs

`--sandbox-ceiling <value>` sets the most access any tool call in the run may use. Calls beyond it
are blocked with the reason, and nothing asks, so it suits subagents (`pi -p`). The value is
`read-only`, or a JSON sandbox object whose paths resolve against the run's cwd, such as
`'{"writableLocations":["src"],"networkAccess":"fetch-only"}'`.

- `bash` and `job_start`: the `sandbox` declaration must fit inside the ceiling.
- `write` and `edit`: the path must be inside the ceiling's `writableLocations` or the scratchpad,
  and not under `.git/hooks` or `.git/config`.
- `read`, `grep`, `find`, `ls`, `job_watch`, `job_stop` run; every other tool is blocked.
- An invalid value blocks everything except those read-only tools.

The flag adds no prompt text, so a fork child keeps the parent's prompt cache.

## Limits

- Reading is not restricted: anything the user can read (`~/.ssh`, credentials) is readable, and
  `fetch-only` can still send it out in a URL. Hidden paths are a planned stage-2 control.
- Sandboxes do not nest: Landlock forbids the mounts bwrap needs. A pi started from a sandboxed
  command fails with a clear error; subagents (`pi -p` via `job_start`) declare
  `dangerouslySkipSandbox` and sandbox their own commands.
- User `!` commands are not sandboxed.

## Interface for jobs and btw

jobs and btw work without this extension, so they do not import it at run time. They find it on
the `pi.events` channel `archibate.sandbox:get`, an interface private to these extensions (pi has
no sandbox API): they emit a reply callback, and this extension answers synchronously with a
`SandboxProvider` (`sandbox.ts`) holding `prepare`, `isReadOnly`, the reference `parameter` schema,
and the description `note`. pi.events is per runtime, so after a `/reload` without this extension
nothing answers.

- jobs declares `job_start` at load, then redeclares it with the `sandbox` parameter at
  `session_start` if the provider answers.
- btw's side session reloads the main session's extensions, so its `bash` is the same declaration
  (prompt-cache prefix). It allows only `isReadOnly` calls, and blocks bash when nothing answers.

## Requirements

Linux with bubblewrap, Landlock ABI 9 or newer, a C compiler (the helper is built on first
use into `${XDG_CACHE_HOME:-~/.cache}/pi/sandbox/<source-hash>/`), and `socat` for `fetch-only`.
Each check fails closed with an explanatory error. Overhead is about 15 ms per command.

## Files

| File | Role |
|---|---|
| `policy.ts` | Schema, defaults, path resolution, badge text (pure). |
| `ceiling.ts` | `--sandbox-ceiling` parsing and per-call checks (pure). |
| `bwrap.ts` | Policy + host facts → bwrap arguments, landlock-exec entry, environment (pure). |
| `host.ts` | Host facts, helper build. |
| `landlock-exec.c` | Applies the Landlock IPC rules, then execs the shell. |
| `proxy.ts` | Per-call fetch-only proxy. |
| `sandbox.ts` | `prepareSandbox()` and `execShell()`, shared with jobs and btw. |
| `tool.ts` | The sandboxed `bash` definition, renderer badge, recovery hints. |

## Verification

```bash
just link   # symlink host packages for tsc
just check  # tsc --noEmit
just test   # unit, proxy, real-sandbox, and pi-loader integration tests (no model requests)
```

The real-sandbox tests build the helper and keep every file they create in one temporary
directory under `~/.cache`.
