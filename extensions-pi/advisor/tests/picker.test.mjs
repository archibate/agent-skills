import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";
const f = fixture();
after(f.cleanup);
const { AdvisorPicker } = await f.load("picker.ts");
const tui = await import(`${f.host}/../pi-tui/dist/index.js`);
const { KeybindingsManager } = await import(`${f.host}/dist/core/keybindings.js`);
const { loadThemeFromPath } = await import(`${f.host}/dist/modes/interactive/theme/theme.js`);
const models = [
	{ provider: "ofox", id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", api: "anthropic-messages" },
	{ provider: "ofox", id: "openai/gpt-6-luna", name: "Luna 月亮", api: "openai-responses" },
	{ provider: "virtual", id: "router", name: "Virtual router", api: "pi-virtual" },
];
function picker(options = {}, bindings = {}) {
	const keys = new KeybindingsManager(bindings);
	tui.setKeybindings(keys);
	let result = "pending";
	let completions = 0;
	const component = new AdvisorPicker({ requestRender() {} }, loadThemeFromPath(join(f.host, "dist/modes/interactive/theme/dark.json")), keys,
		(value) => { result = value; completions++; }, { main: "ofox/openai/gpt-6-luna", models, ...options });
	component.focused = true;
	return { component, get result() { return result; }, get completions() { return completions; } };
}
const plain = (component, width = 80) => component.render(width).map((line) => stripVTControlCharacters(line.replaceAll(tui.CURSOR_MARKER, ""))).join("\n");

test("picker fuzzy search, Enter, Ctrl+S, cancel, none, and configurable save keys", () => {
	const h = picker();
	assert.equal(h.component.focused, true);
	assert.ok(h.component.render(80).some((line) => line.includes(tui.CURSOR_MARKER)), "IME cursor marker must survive rendering");
	assert.doesNotMatch(plain(h.component), /router/);
	h.component.handleInput("opus");
	assert.match(plain(h.component), /claude-opus/);
	h.component.handleInput("\r");
	assert.deepEqual(h.result, { model: "ofox/anthropic/claude-opus-5.5", save: false });
	h.component.handleInput("\x13");
	assert.equal(h.completions, 1);
	const save = picker({ query: "luna" }); save.component.handleInput("\x13");
	assert.deepEqual(save.result, { model: "ofox/openai/gpt-6-luna", save: true });
	const none = picker(); none.component.handleInput("\x13");
	assert.deepEqual(none.result, { model: null, save: true });
	const cancel = picker(); cancel.component.handleInput("\x1b"); assert.equal(cancel.result, undefined);
	const remapped = picker({ query: "opus" }, { "app.models.save": "ctrl+d" });
	assert.match(plain(remapped.component), /ctrl\+d/);
	remapped.component.handleInput("\x04"); assert.equal(remapped.result.save, true);
	const empty = picker({ query: "zzzzzzzz" });
	empty.component.handleInput("\r"); empty.component.handleInput("\x13");
	assert.equal(empty.result, "pending");
	assert.match(plain(empty.component), /No matching models/);
});

test("cursor-only input preserves the highlighted match and narrow views identify duplicate model IDs", () => {
	const h = picker({ query: "ofox" });
	const selected = () => plain(h.component).match(/Selected: ([^\n]+)/)[1].trim();
	const first = selected();
	h.component.handleInput("\x1b[B");
	const highlighted = selected();
	assert.notEqual(highlighted, first);
	h.component.handleInput("\x1b[D");
	h.component.handleInput("\x01");
	h.component.handleInput("\x13");
	assert.deepEqual(h.result, { model: highlighted, save: true });
	const duplicate = picker({ query: "same", models: [
		{ provider: "provider-a", id: "same", name: "Same", api: "openai-completions" },
		{ provider: "provider-b", id: "same", name: "Same", api: "openai-completions" },
	] });
	assert.match(plain(duplicate.component, 20).replace(/\s/g, ""), /Selected:provider-a\/same/);
	duplicate.component.handleInput("\x1b[B");
	assert.match(plain(duplicate.component, 20).replace(/\s/g, ""), /Selected:provider-b\/same/);
	duplicate.component.handleInput("\r");
	assert.equal(duplicate.result.model, "provider-b/same");
});

test("picker renders bounded terminal rows at narrow/normal/wide widths in both themes", () => {
	const renderings = [];
	for (const name of ["dark", "light"]) for (const width of [20, 32, 80, 120]) {
		const keys = new KeybindingsManager(); tui.setKeybindings(keys);
		const theme = loadThemeFromPath(join(f.host, `dist/modes/interactive/theme/${name}.json`));
		for (const query of ["", "luna", "nothing-matches"]) {
			const component = new AdvisorPicker({ requestRender() {} }, theme, keys, () => {}, {
				main: "ofox/openai/gpt-6-luna", models, current: "ofox/openai/gpt-6-luna", saved: null, query,
			});
			component.focused = true;
			for (const row of component.render(width)) assert.ok(tui.visibleWidth(row) <= width, `${width}: ${row}`);
			renderings.push(`${name} / ${width} columns / query=${query}\n${plain(component, width)}`);
		}
	}
	if (process.env.PI_ADVISOR_RENDER_DIR) writeFileSync(join(process.env.PI_ADVISOR_RENDER_DIR, "advisor-picker.txt"), renderings.join("\n\n"));
});
