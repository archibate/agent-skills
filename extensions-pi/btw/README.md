# btw

`/btw` asks a side question without disturbing the main conversation.

The side session is seeded with the entire current branch, so its provider
request is a strict extension of the main session's last request and the prompt
cache serves the whole prefix; only the question is billed as new input. The
overlay reuses pi's transcript components, so the exchange looks like the main
chat. Nothing is written back to the main session, and the command runs even
while the main agent is still streaming.

## Read-only sandbox

`read`, `grep`, `find`, and `ls` run normally. `bash` needs the
[sandbox](../sandbox) extension, whose permissions are fixed to read-only with
the deny reviewer in the side session: calls that declare any access beyond its
read-only default are blocked; set `BTW_SANDBOX_NET=1` to also allow declared
network access. Without the sandbox extension, or with it disabled, `bash` is blocked. All other
mutating tools are blocked; every tool stays declared, so the prompt cache is
shared.

Each invocation reloads the session's extensions, which takes a few hundred ms.
