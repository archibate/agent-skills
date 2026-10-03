import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptStash } from "../stash.ts";

test("stashes non-empty text and clears the editor", () => {
	const stash = new PromptStash();
	assert.deepEqual(stash.toggle("first draft"), { editor: "", stash: "first draft", outcome: "stashed" });
	assert.equal(stash.stashed, "first draft");
});

test("restores the stash into an empty editor", () => {
	const stash = new PromptStash();
	stash.toggle("parked");
	assert.deepEqual(stash.toggle(""), { editor: "parked", stash: undefined, outcome: "restored" });
	assert.equal(stash.stashed, undefined);
});

test("swaps between the editor and the stash so neither draft is lost", () => {
	const stash = new PromptStash();
	stash.toggle("first");
	assert.deepEqual(stash.toggle("second"), { editor: "first", stash: "second", outcome: "swapped" });
	assert.deepEqual(stash.toggle("first"), { editor: "second", stash: "first", outcome: "swapped" });
});

test("does nothing when both the editor and the stash are empty", () => {
	const stash = new PromptStash();
	assert.deepEqual(stash.toggle(""), { editor: "", stash: undefined, outcome: "empty" });
	assert.deepEqual(stash.toggle("   \n"), { editor: "   \n", stash: undefined, outcome: "empty" });
});

test("whitespace-only editor content restores instead of overwriting the stash", () => {
	const stash = new PromptStash();
	stash.toggle("parked");
	assert.deepEqual(stash.toggle("   "), { editor: "parked", stash: undefined, outcome: "restored" });
});
