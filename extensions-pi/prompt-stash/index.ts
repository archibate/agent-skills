/**
 * Prompt stash: park the draft you are writing with Ctrl+S, send the prompt that
 * just came to mind, then Ctrl+S again to bring the parked draft back.
 *
 * Ctrl+S is context-specific in pi: the session picker uses it to toggle sort
 * and the model/thinking selectors use it to save. Those components keep their
 * meaning either way, because they never route input through the prompt editor.
 * This installs a CustomEditor subclass that claims Ctrl+S only while the editor
 * has focus, instead of registering a global extension shortcut. A global
 * shortcut would make pi print a static "shortcut conflict" notice at startup
 * for a key that does not actually conflict. Other extensions' shortcuts keep
 * working because setEditorComponent delegates them to the default editor.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { PromptStash, type StashOutcome } from "./stash.ts";

type EditorArgs = ConstructorParameters<typeof CustomEditor>;

const MESSAGES: Record<StashOutcome, string> = {
	stashed: "Prompt stashed — Ctrl+S again to restore it",
	swapped: "Swapped with the stashed prompt — Ctrl+S again to swap back",
	restored: "Stashed prompt restored",
	empty: "No prompt to stash, and nothing in the stash",
};

class StashEditor extends CustomEditor {
	private readonly onStash: () => void;

	constructor(tui: EditorArgs[0], theme: EditorArgs[1], keybindings: EditorArgs[2], onStash: () => void) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.onStash = onStash;
	}

	override handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("s"))) {
			this.onStash();
			return;
		}
		super.handleInput(data);
	}
}

export default function promptStashExtension(pi: ExtensionAPI): void {
	const stash = new PromptStash();

	pi.on("session_start", (_event, ctx) => {
		const ui = ctx.ui;
		ui.setEditorComponent((tui, theme, keybindings) =>
			new StashEditor(tui, theme, keybindings, () => {
				// ui.getEditorText()/setEditorText() expand collapsed pastes, so a
				// stashed draft survives instead of degenerating into paste markers.
				const { editor, outcome } = stash.toggle(ui.getEditorText());
				if (outcome !== "empty") ui.setEditorText(editor);
				ui.notify(MESSAGES[outcome], "info");
			}),
		);
	});
}
