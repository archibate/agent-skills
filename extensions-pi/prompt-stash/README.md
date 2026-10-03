# prompt-stash

Park the prompt you are writing with **Ctrl+S**, send the thought that just
interrupted you, then press **Ctrl+S** again to bring the parked draft back —
the Claude Code prompt-stash gesture.

## Behavior

The stash is a single draft held in the extension's memory. Ctrl+S in the
prompt editor:

| Editor | Stash | Result |
|---|---|---|
| non-empty | empty | draft parked, editor cleared |
| non-empty | non-empty | editor and stash are swapped, so neither draft is lost |
| empty | non-empty | stash restored into the editor |
| empty | empty | no-op |

A short status line confirms each action. The stash is not written to the
session, so it is dropped on `/reload`, session switch, or exit.

## Notes

Ctrl+S is context-specific in pi: the session picker uses it to toggle sort and
the model/thinking selectors use it to save. Those components keep their
meaning because their input never routes through the prompt editor.

The extension installs a `CustomEditor` subclass and claims Ctrl+S only while
the editor has focus. That is deliberate: `pi.registerShortcut` would make pi
print a static `[Extension warnings]` shortcut-conflict notice at startup for a
key that does not actually conflict. The subclass keeps the embedded working
indicator and forwards other extensions' shortcuts to the default editor.

## Verification

Unit tests cover the stash state machine:

```bash
node --test ~/.pi/agent/extensions/prompt-stash/tests/prompt-stash.test.mjs
```

The offline integration test boots the installed Pi runtime and the extension
without making model requests. Set `PI_SDK_PATH` to the release's
`dist/index.js`:

```bash
PI_SDK_PATH="$HOME/.pi/agent/install/releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js" \
  node --test ~/.pi/agent/extensions/prompt-stash/tests/integration.test.mjs
```

Without `PI_SDK_PATH`, the integration test is skipped. Tests require Node's
TypeScript stripping support.
