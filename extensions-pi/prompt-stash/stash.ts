/**
 * Prompt-stash state machine. Kept free of pi imports so the behavior is unit
 * testable without an editor or a model.
 *
 * There is a single stash slot. Toggling with text in the editor parks that text
 * and either restores the previous stash (swap) or clears the editor. Toggling
 * with an empty editor restores the stash.
 */

export type StashOutcome = "stashed" | "swapped" | "restored" | "empty";

export interface StashTransition {
	/** Text the editor should hold after the toggle. */
	editor: string;
	/** Text held in the stash after the toggle, or undefined when none. */
	stash: string | undefined;
	outcome: StashOutcome;
}

export class PromptStash {
	private slot: string | undefined;

	/** The prompt currently parked outside the editor, if any. */
	get stashed(): string | undefined {
		return this.slot;
	}

	/** Apply one Ctrl+S toggle to the current editor text. */
	toggle(editor: string): StashTransition {
		if (editor.trim() === "") {
			const restored = this.slot;
			if (restored === undefined || restored.trim() === "") {
				return { editor, stash: this.slot, outcome: "empty" };
			}
			this.slot = undefined;
			return { editor: restored, stash: undefined, outcome: "restored" };
		}
		const previous = this.slot;
		this.slot = editor;
		if (previous === undefined || previous.trim() === "") {
			return { editor: "", stash: this.slot, outcome: "stashed" };
		}
		return { editor: previous, stash: this.slot, outcome: "swapped" };
	}
}
