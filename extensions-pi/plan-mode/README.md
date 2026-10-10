# plan-mode

Read-only planning with an editable scratchpad document, interactive questions,
and user-approved execution. With sandboxing enabled, a temporary permission
ceiling enforces planning access; otherwise read-only planning is guidance.

## Tools

- `enter_plan_mode()` enters planning and returns the Markdown file path. Repeated
  entry keeps the same file and checkpoint.
- `ask_question({ questions })` asks up to four questions, with optional choices
  and a free-text alternative. Available in any mode.
- `exit_plan_mode({ plan_path })` renders the completed file as Markdown in the
  transcript and asks for approval. Call entry and exit tools without sibling calls.

The approval choices are **Execute from checkpoint**, **Continue here**,
**Request changes**, and **Keep planning**. Checkpoint execution branches in place
from planning's entry boundary, carrying the approved snapshot into implementation.
Investigation stays accessible in `/tree`, without an extra generated summary or
new session. Cancellation keeps planning active.

## Manual controls

```text
/plan              toggle planning
/plan on [prompt]  enter planning, optionally send a prompt
/plan off [prompt] exit directly, optionally send a prompt
/plan <prompt>     enter planning and send a prompt
Ctrl+Alt+P         toggle planning
pi --plan         start in planning
```

Manual and tool entry share the same state. Manual toggles during a running turn
apply after its tool batch. Status shows `⏸ plan` while active.

## Sandbox integration

When the `sandbox` extension is enabled, planning caps new calls at read-only
filesystem access (the scratchpad remains writable) and at most `fetch-only`
networking. Repository writes, sandbox escapes, extra host access, and other tools
outside the ceiling are denied before review. Planning and question tools remain usable.

The ceiling does not change saved `/permissions` or grant access missing from
those permissions. It follows planning across reload and `/tree`, and is removed
on approved or manual exit. Checkpoint execution carries the current base
permissions, including edits made during planning. Existing jobs retain their launch permissions.
The sandbox's fetch-only proxy restricts destinations, not HTTPS request methods.

## Storage and context

Plans live at `$XDG_CACHE_HOME/pi/scratchpad/<session-id>/plan-<id>.md`
(default cache root: `~/.cache`). The extension works with or without the
`scratchpad` extension. Files survive reload and shutdown; the repository is untouched.
Plans must be nonempty UTF-8 Markdown, at most 64 KiB, and not symlinks.

Mode, path, and checkpoint are restored from the active session branch. Approved
snapshots are also saved in session history, so later file edits do not change
what was approved. A file changed during review must be presented again.

All three tools remain declared with stable schemas in both modes. Mode notices
are appended, never removed from history. Switching modes does not swap the tool
list or rewrite the system prompt. Checkpoint execution preserves the shared
prefix and starts a new suffix with the approved plan.

TUI and RPC clients can answer questions and approve plans. The TUI asks a whole
question batch in one dialog; RPC clients receive the same questions as plain
selects. Without interactive UI, these tools stop for user input rather than
approving automatically.

## Checks

Tested with Pi 1.0.4. Offline tests use its real agent loop, session tree, and
Markdown renderer with fixture model responses and dialogs:

```sh
node --test extensions-pi/plan-mode/tests/*.test.mjs
```

Tests locate the installed Pi, or accept `PI_SDK_PATH` pointing to its
`dist/index.js`. All test files and configuration live in private scratch fixtures.
An opt-in Linux kernel check writes only inside its private fixture, without networking:

```sh
PI_PLAN_KERNEL_TEST=1 node --test extensions-pi/plan-mode/tests/kernel.test.mjs
```
