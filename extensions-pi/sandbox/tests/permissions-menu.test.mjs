import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import sandboxExtension from "../index.ts";

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const down = "\x1b[B";

async function runMenu({ keys = [], answers = [], mode = "tui" } = {}) {
	let command;
	const entries = [];
	sandboxExtension({
		registerTool() {}, registerFlag() {}, registerToolRenderer() {}, on() {},
		getFlag: (name) => (name === "enable-sandbox" ? true : undefined),
		events: { on() {} },
		registerCommand(name, definition) { if (name === "permissions") command = definition.handler; },
		appendEntry(type, data) { entries.push({ type, data }); },
	});
	const frames = [];
	const dialogs = [];
	const statuses = [];
	await command("", {
		cwd: process.cwd(), hasUI: true, mode,
		ui: {
			theme: plainTheme,
			setStatus: (key, text) => statuses.push({ key, text }),
			custom: (factory) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, plainTheme, getKeybindings(), resolve);
				component.invalidate();
				for (const width of [30, 80, 120]) {
					for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, line);
				}
				frames.push(component.render(120).map(stripVTControlCharacters).join("\n"));
				const sequence = keys.shift();
				assert.ok(sequence, "unexpected extra menu");
				for (const key of sequence) component.handleInput(key);
			}),
			select: async (title, options) => {
				dialogs.push({ title, options });
				const answer = answers.shift();
				return typeof answer === "number" ? options[answer] : answer;
			},
		},
	});
	return { frames, dialogs, entries, statuses };
}

test("permissions returns to the selected row after changing its label", async () => {
	const { frames, entries, statuses } = await runMenu({ keys: [
		[down, down, down, down, "\r"],
		["\r"],
		["\x1b"],
	] });
	assert.match(frames[0], /→ Writable locations:/);
	assert.match(frames[1], /→ Display: on/);
	assert.match(frames[2], /→ Display: off/);
	assert.deepEqual(entries.map((entry) => entry.data.policy.display), [true, false]);
	assert.equal(statuses[0].key, "sandbox-permissions");
	assert.match(statuses[0].text, /· display/);
	assert.doesNotMatch(statuses[1].text, /· display/);
});

test("permissions returns to the selected row after editing or cancelling a submenu", async () => {
	const { frames, dialogs } = await runMenu({
		keys: [[down, "\r"], ["\r"], ["\x1b"]],
		answers: ["full", undefined],
	});
	assert.match(frames[1], /→ Network: full/);
	assert.match(frames[2], /→ Network: full/);
	assert.deepEqual(dialogs.map((dialog) => dialog.title), ["Network", "Network"]);
});

test("d/r reset permissions immediately without moving the cursor", async () => {
	const { frames, entries } = await runMenu({ keys: [
		[...Array(4).fill("j"), "\n"],
		["r"],
		["d"],
		["k", "\r"],
		["\x1b"],
	] });
	assert.match(frames[0], /d reset to default  r reset to read-only/);
	assert.doesNotMatch(frames[0], /^\s*(?:→ )?Reset to /m);
	assert.match(frames[1], /→ Display: on/);
	assert.match(frames[2], /→ Display: off/);
	assert.match(frames[3], /→ Display: off/);
	assert.match(frames[4], /→ Session and system bus: on/);
	assert.equal(entries.length, 4);
	assert.equal(entries[1].data.policy.network, "disable");
	assert.deepEqual(entries[1].data.tools, []);
	assert.equal(entries[2].data.policy.network, "fetch-only");
	assert.equal(entries[2].data.tools, "all");
});

test("permissions retains the standard select dialog outside the TUI", async () => {
	const { frames, dialogs } = await runMenu({ mode: "rpc", answers: [4, undefined] });
	assert.deepEqual(frames, []);
	assert.equal(dialogs.length, 2);
	assert.equal(dialogs[1].options[4], "Display: on");
	assert.deepEqual(dialogs[0].options.slice(-2), ["Reset to default", "Reset to read-only"]);
});

test("RPC reset rows still apply their presets", async () => {
	const { entries } = await runMenu({ mode: "rpc", answers: [9, 10, undefined] });
	assert.equal(entries[0].data.policy.network, "fetch-only");
	assert.equal(entries[0].data.tools, "all");
	assert.equal(entries[1].data.policy.network, "disable");
	assert.deepEqual(entries[1].data.tools, []);
});
