/**
 * End key: move to end of the current input line (the Ctrl-e effect), and when
 * the cursor is already there, scroll the transcript to the bottom.
 *
 * In fullscreen mode the alt-screen viewport binds `end` to
 * `tui.altScreen.bottom` by default and consumes it before the focused editor
 * sees it, so this extension also requires `keybindings.json` to move that
 * action off `end` (see README). Only the bare `end` key is intercepted;
 * `ctrl+e` and `ctrl+end` keep their normal line-end behavior.
 *
 * Why a prototype patch instead of `ctx.ui.setEditorComponent`: only one editor
 * factory is retained, so a second extension calling it (prompt-stash does)
 * would silently replace ours. Wrapping `CustomEditor.prototype.handleInput`
 * composes with any subclass that forwards unhandled keys to `super`, which is
 * the documented pattern. `ctx.ui.editor()` and other dialogs use pi-tui's
 * `Input`/`Editor`, not `CustomEditor`, so they are unaffected.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("pi.end-key.patched");

interface EditorLike {
	getCursor(): { line: number; col: number };
	getLines(): string[];
	tui?: { scrollToBottom?: () => void };
	handleInput(data: string): void;
}

export default function (pi: ExtensionAPI): void {
	const proto = CustomEditor.prototype as unknown as EditorLike & { [PATCHED]?: boolean };
	if (proto[PATCHED]) return; // survive /reload without double-wrapping
	proto[PATCHED] = true;

	const original = proto.handleInput;

	proto.handleInput = function (this: EditorLike, data: string): void {
		if (matchesKey(data, "end")) {
			const { line, col } = this.getCursor();
			const lineLength = this.getLines()[line]?.length ?? 0;
			if (col < lineLength) {
				original.call(this, data); // Ctrl-e: move to end of the current line
				return;
			}
			// Already at the end of the current line: jump the transcript to the
			// bottom. The active renderer exposes scrollToBottom only in fullscreen.
			const scrollToBottom = this.tui?.scrollToBottom;
			if (typeof scrollToBottom === "function") {
				scrollToBottom.call(this.tui);
				return;
			}
			// Main-screen mode owns no viewport; fall through to normal handling.
		}
		original.call(this, data);
	};
}
