# end-key

Makes `End` act on the input box first: it moves the cursor to the end of the
current line (the `Ctrl-e` effect), and when the cursor is already there it
scrolls the transcript to the bottom.

## Why the keybindings change is required

In fullscreen mode the alt-screen viewport binds `End` to `tui.altScreen.bottom`
and consumes it before the focused editor receives it, so an editor hook alone
never sees the key. `~/.pi/agent/keybindings.json` must move that action off `End`:

```json
{
  "tui.altScreen.bottom": "alt+end"
}
```

`alt+end` then remains an explicit jump-to-latest. Use `[]` instead to drop that
key entirely. Run `/reload` after editing.

## Behavior

- `End` with the cursor before the line end → move to the line end.
- `End` at the line end (fullscreen) → scroll the transcript to the bottom.
- `End` at the line end (main-screen mode) → normal editor handling (no owned viewport).
- `Ctrl-e` / `Ctrl+end` are untouched and always move to the line end.

## Composition

Composes by wrapping `CustomEditor.prototype.handleInput`, not by calling
`ctx.ui.setEditorComponent`. Only one editor factory is retained, so a second
`setEditorComponent` call (prompt-stash makes one) would silently replace
whichever registered first. The prototype patch applies to any subclass that
forwards unhandled keys to `super`, which is the documented extension pattern.
`ctx.ui.editor()` and other dialogs use pi-tui's `Input`/`Editor`, not
`CustomEditor`, so they are unaffected.

## Note

"Already at the end" means the end of the **current line**, matching `Ctrl-e`.
In a multi-line prompt, `End` on a non-last line jumps to that line's end;
pressing it again scrolls the transcript.
