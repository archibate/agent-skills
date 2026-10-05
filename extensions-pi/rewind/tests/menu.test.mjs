import assert from "node:assert/strict";
import { test } from "node:test";
import { pickCheckpoint } from "../menu.ts";

// menu.ts has no runtime imports, so these tests run without the pi-tui package.
const lib = {
	truncateToWidth: (text, maxWidth, ellipsis = "...") =>
		text.length > maxWidth ? `${text.slice(0, Math.max(0, maxWidth - ellipsis.length))}${ellipsis}` : text,
};

const theme = { fg: (_token, text) => text, bold: (text) => text };

const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };

const entries = [
	{
		time: "10:00:00",
		prompt: "first",
		added: 4,
		removed: 5,
		files: [
			{ path: "a.txt", added: 1, removed: 3 },
			{ path: "b.txt", added: 3, removed: 2 },
		],
	},
	{ time: "10:05:00", prompt: "second", added: 1, removed: 0, files: [{ path: "c.txt", added: 1, removed: 0 }] },
];

/** Captures the component the factory builds and the resolver it calls on done(). */
function fakeCtx(keybindings) {
	const state = {};
	const ctx = {
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					state.done = resolve;
					state.component = factory(tui, theme, keybindings, resolve);
				}),
		},
	};
	return { ctx, state };
}

const plainKeys = { matches: () => false, getKeys: () => [] };

test("picker renders multi-line entries with prompt, totals, and per-file stats", async () => {
	const { ctx, state } = fakeCtx(plainKeys);
	const promise = pickCheckpoint(ctx, lib, entries);

	const lines = state.component.render(80);
	const text = lines.join("\n");
	assert.match(text, /10:00:00 "first" \+4 -5/);
	assert.match(text, /a\.txt \+1 -3/);
	assert.match(text, /b\.txt \+3 -2/);
	assert.match(text, /10:05:00 "second" \+1 -0/);
	assert.match(text, /c\.txt \+1 -0/);
	// Only the selected entry carries the arrow marker.
	assert.match(lines.find((line) => line.includes("10:00:00")), /^→ /);
	assert.match(lines.find((line) => line.includes("10:05:00")), /^ {2}/);

	state.done(undefined);
	assert.equal(await promise, undefined);
});

test("picker moves the selection and returns the chosen index", async () => {
	const keys = { matches: (data, action) => data === action, getKeys: () => [] };
	const { ctx, state } = fakeCtx(keys);
	const promise = pickCheckpoint(ctx, lib, entries);

	assert.match(state.component.render(80).find((line) => line.includes("10:00:00")), /^→ /);
	state.component.handleInput("tui.select.down");
	assert.match(state.component.render(80).find((line) => line.includes("10:05:00")), /^→ /);
	state.component.handleInput("tui.select.confirm");

	assert.equal(await promise, 1);
});

test("picker cancels with undefined", async () => {
	const keys = { matches: (data, action) => data === action, getKeys: () => [] };
	const { ctx, state } = fakeCtx(keys);
	const promise = pickCheckpoint(ctx, lib, entries);

	state.component.handleInput("tui.select.cancel");
	assert.equal(await promise, undefined);
});

test("picker keeps the selected entry visible when it scrolls past the window", async () => {
	const shortTui = { terminal: { rows: 8, columns: 80 }, requestRender() {} };
	const many = Array.from({ length: 12 }, (_, index) => ({
		time: `10:${String(index).padStart(2, "0")}:00`,
		prompt: `prompt ${index}`,
		added: index,
		removed: 0,
		files: [{ path: `file-${index}.txt`, added: index, removed: 0 }],
	}));
	const keys = { matches: (data, action) => data === action, getKeys: () => [] };
	const state = {};
	const ctx = {
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					state.done = resolve;
					state.component = factory(shortTui, theme, keys, resolve);
				}),
		},
	};
	const promise = pickCheckpoint(ctx, lib, many);

	for (let i = 0; i < 11; i++) state.component.handleInput("tui.select.down");
	const text = state.component.render(80).join("\n");
	assert.match(text, /10:11:00 "prompt 11"/);
	assert.doesNotMatch(text, /10:00:00/);

	state.component.handleInput("tui.select.cancel");
	await promise;
});
