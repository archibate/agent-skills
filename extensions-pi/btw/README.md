# btw

`/btw` asks a side question without disturbing the main conversation.

The side session is seeded with the entire current branch, so its provider
request is a strict extension of the main session's last request and the prompt
cache serves the whole prefix; only the question is billed as new input. The
overlay reuses pi's transcript components, so the exchange looks like the main
chat. Nothing is written back to the main session, and the command runs even
while the main agent is still streaming.

## Read-only sandbox

`read`, `grep`, `find`, and `ls` run normally. `bash` runs inside a bubblewrap
jail: the filesystem is read-only except the session scratchpad
(`PI_SCRATCHPAD_DIR`, falling back to `TMPDIR`). Network is denied by default;
set `BTW_SANDBOX_NET=1` to allow it. All other mutating tools are blocked.

Without `bwrap` (Linux only), `bash` stays disabled. Each invocation reloads the
session's extensions, which takes a few hundred ms.
