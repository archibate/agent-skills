# rewind

Per-prompt **file checkpoints** for pi: restore the files pi edited back to an
earlier prompt, next to pi's existing conversation rewind.

`/tree`, `/fork`, and `/clone` are untouched. They rewind conversation only,
exactly as before. `/rewind` is the added capability: it offers code restore as
an explicit choice and never changes files on its own.

## Usage

Run `/rewind` (or press `Ctrl+Alt+R`), pick a prompt, then pick an action. In
the TUI each entry is a colored block with the prompt time, a one-line preview
of your prompt, the total added/removed lines, and one line per changed file:

```
10:42:07 "fix the login redirect" +4 -5
  src/auth.ts +1 -3
  src/routes.ts +3 -2
```

The added/removed counts are the lines that prompt introduced, computed from
the captured pre-image and the file's content afterwards (the next checkpoint
that touched it, or its current content). Other UI modes fall back to a
single-line selector with the same information.

- **Restore code and conversation** — roll files back to the state before that
  prompt, then navigate the session tree to that prompt.
- **Restore conversation only** — navigate only; files untouched.
- **Restore code only** — roll files back; conversation untouched.

Code restore is chronological: every file pi edited at or after the chosen
prompt is rolled back to the pre-image of its first such edit. Files pi did not
edit after that prompt are left alone.

## How it works

- `before_agent_start` opens a checkpoint. At `agent_before_settle` it is
  anchored to the last user message on the branch — the prompt that started the
  run — and appended as a `rewind` custom entry, so checkpoints survive
  `/reload` and `--resume`. An aborted run that never reaches the settle
  boundary is persisted at `agent_settled` instead.
- Before each `edit`/`write` tool call, the file's current bytes are stored
  content-addressed under `<agent-dir>/rewind/<session-id>/blobs/`. The same
  content is stored once no matter how many checkpoints reference it.
- The newest 100 checkpoints are kept; older ones and their unreferenced blobs
  are pruned. Concurrent sessions never touch each other's blob directory, so
  pruning is safe.

Checkpoints only hold pre-images of files pi was about to change, so disk use
tracks edited files, not repository size.

## Limits

Same scope as Claude Code's checkpoints:

- Files changed by `bash` (`rm`, `mv`, `cp`, …) are not captured.
- Changes you make in your editor, and changes from another concurrent session,
  are not captured.
- Files written by tools other than `edit`/`write` are not captured.
- Symlinked and hard-linked paths are skipped, so restoring one does not
  replace the link.
- Paths outside the working directory are skipped.
- Not a replacement for version control.

## Configuration

Optional `<agent-dir>/rewind.json`:

```json
{ "enabled": true, "maxCheckpoints": 100 }
```

`enabled: false` turns capture off. After editing the file, run `/reload`.

## Verification

Unit tests cover the snapshot store, restore planning, line change counts, and
the picker component:

```bash
node --test ~/.pi/agent/extensions/rewind/tests/rewind.test.mjs
node --test ~/.pi/agent/extensions/rewind/tests/menu.test.mjs
```

The integration test drives the extension through a fake pi runtime (events,
command context, session entries) without a model request. With `PI_SDK_PATH`
set to the release's `dist/index.js`, it also boots the real pi runtime and
checks that a user prompt produces a checkpoint anchored to that message:

```bash
PI_SDK_PATH="$HOME/.pi/agent/install/releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
  node --test ~/.pi/agent/extensions/rewind/tests/integration.test.mjs
```

Without `PI_SDK_PATH`, the runtime test is skipped.

Tests require Node's TypeScript stripping support.
