import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import jobsExtension from "../index.ts";

// Register jobs alone: no sandbox extension, runtime, shell commands, or model calls.
const tools = new Map();
const messages = new Map();
jobsExtension({
	registerTool: (tool) => tools.set(tool.name, tool),
	registerMessageRenderer: (type, renderer) => messages.set(type, renderer),
	registerCommand() {},
	on() {},
});
const renderCall = tools.get("job_start").renderCall;
const renderMessage = messages.get("job");
const plainTheme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const context = () => ({ toolCallId: "render", state: {}, executionStarted: false });
const textOf = (component) => component.render(120).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

test("job notifications collapse logs without duplicating the job label", () => {
	const content = '[job 132f "renderer"] exit 0\n' + Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = { customType: "job", content, display: true };
	const collapsed = textOf(renderMessage(message, { expanded: false, outputPad: 0 }, plainTheme)).trim();
	assert.match(collapsed, /^\[job 132f "renderer"\] exit 0\n/);
	assert.match(collapsed, /15 earlier lines/);
	assert.match(collapsed, /line 16\nline 17\nline 18\nline 19\nline 20$/);
	assert.doesNotMatch(collapsed, /\[job\]|line 1\n/);
	assert.equal(textOf(renderMessage(message, { expanded: true, outputPad: 0 }, plainTheme)).trim(), content);
	assert.equal(message.content, content, "rendering does not truncate the model-facing notification");
});

const mouseEvent = (type = "click", button = "left") => ({
	type, button, x: 2, y: 1, screenX: 2, screenY: 1, width: 80, height: 9,
	shift: false, alt: false, ctrl: false,
});

test("left-click toggles only this notification and requests a redraw", () => {
	const content = "[job click] exit 0\n" + Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = { content };
	const options = { expanded: false, outputPad: 1 };
	const component = renderMessage(message, options, plainTheme);
	const sibling = renderMessage({ content }, options, plainTheme);
	const collapsed = textOf(component);
	const siblingLines = textOf(sibling);
	assert.match(collapsed, /15 earlier lines/);
	assert.deepEqual(component.handleMouse(mouseEvent()), { handled: true, render: true });
	assert.equal(textOf(component).split("\n").map((line) => line.trim()).join("\n").trim(), content);
	assert.equal(textOf(sibling), siblingLines, "clicks do not expand other notifications");
	component.invalidate();
	assert.doesNotMatch(textOf(component), /earlier lines/);
	const rebuilt = renderMessage(message, { ...options, outputPad: 2 }, plainTheme);
	assert.doesNotMatch(textOf(rebuilt), /earlier lines/, "click state survives the host rebuilding its child");
	assert.ok(rebuilt.render(20).length > 9, "resizing preserves expansion");
	assert.deepEqual(rebuilt.handleMouse(mouseEvent()), { handled: true, render: true });
	assert.equal(textOf(component), collapsed, "rebuilt and existing views share the same per-message state");
	assert.match(textOf(rebuilt), /15 earlier lines/);
	assert.equal(message.content, content);
});

test("keyboard expansion overrides local clicks on the next global toggle", () => {
	const message = { content: "[job keyboard] exit 0\n" + Array(20).fill("log").join("\n") };
	let component = renderMessage(message, { expanded: false, outputPad: 0 }, plainTheme);
	component.handleMouse(mouseEvent());
	assert.doesNotMatch(textOf(component), /earlier lines/);
	component = renderMessage(message, { expanded: true, outputPad: 0 }, plainTheme);
	component.handleMouse(mouseEvent());
	assert.match(textOf(component), /earlier lines/);
	component = renderMessage(message, { expanded: false, outputPad: 0 }, plainTheme);
	assert.match(textOf(component), /earlier lines/);
	component = renderMessage(message, { expanded: true, outputPad: 0 }, plainTheme);
	assert.doesNotMatch(textOf(component), /earlier lines/);
});

test("scrolling, selection gestures, and non-left clicks do not toggle notifications", () => {
	const message = { content: "[job gestures] exit 0\n" + Array(20).fill("log").join("\n") };
	const component = renderMessage(message, { expanded: false, outputPad: 0 }, plainTheme);
	const collapsed = textOf(component);
	for (const type of ["press", "release", "move", "drag", "wheel"]) {
		assert.equal(component.handleMouse(mouseEvent(type)), undefined);
		assert.equal(textOf(component), collapsed);
	}
	for (const button of ["right", "middle", "none"]) {
		assert.equal(component.handleMouse(mouseEvent("click", button)), undefined);
		assert.equal(textOf(component), collapsed);
	}
});

test("the expansion hint follows the active keybinding", () => {
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand output" } }, { "app.tools.expand": "alt+e" }));
		const message = { content: "[job abc] exit 0\n" + Array(10).fill("log").join("\n") };
		assert.match(textOf(renderMessage(message, { expanded: false, outputPad: 0 }, plainTheme)), /alt\+e to expand/);
	} finally {
		setKeybindings(previous);
	}
});

test("short and structured notifications retain all text without a collapse hint", () => {
	for (const content of ["", "[job abc] exit 0", "[job abc]\nready", [{ type: "text", text: "[job abc] exit 0" }, { type: "text", text: "ready" }]]) {
		const message = { customType: "job", content, display: true };
		const expected = typeof content === "string" ? content : content.map((block) => block.text).join("\n");
		for (const expanded of [false, true]) {
			assert.equal(textOf(renderMessage(message, { expanded, outputPad: 0 }, plainTheme)).trim(), expected);
		}
	}
});

test("notification previews bound visual lines and refresh on resize and invalidation", () => {
	const message = { customType: "job", content: `[job abc "long name"] exit 0\n${"测试 wrapped logs ".repeat(100)}`, display: true };
	const styledTheme = {
		fg: (_color, text) => `\x1b[33m${text}\x1b[39m`,
		bg: (_color, text) => text,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
	for (const theme of [plainTheme, styledTheme]) {
		for (const outputPad of [0, 1, 2]) {
			const component = renderMessage(message, { expanded: false, outputPad }, theme);
			for (const width of [20, 80, 120, 20]) {
				const lines = component.render(width);
				assert.ok(lines.length <= 9, "one status line, hint, five log lines, and vertical padding");
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
				assert.match(lines.map(stripVTControlCharacters).join("\n"), /earlier|\.\.\./);
				component.invalidate();
				assert.deepEqual(component.render(width), lines);
			}
			const expanded = renderMessage(message, { expanded: true, outputPad }, theme).render(80);
			assert.ok(expanded.length > 9);
			assert.equal(expanded.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), message.content.replace(/\s+/g, ""));
		}
	}
});

test("jobs owns its command renderer without sandbox", () => {
	assert.equal(textOf(renderCall({ command: "uv sync", name: "build", timeout: 60 }, plainTheme, context())), "$ uv sync (timeout 60s)");
	assert.equal(textOf(renderCall({ command: "git log" }, plainTheme, context())), "$ git log");
});

test("partial job calls reuse and update their component", () => {
	const ctx = context();
	const component = renderCall({}, plainTheme, ctx);
	assert.equal(textOf(component), "$ ...");
	ctx.lastComponent = component;
	assert.equal(renderCall({ command: "build", timeout: 30 }, plainTheme, ctx), component);
	assert.equal(textOf(component), "$ build (timeout 30s)");
	assert.equal(renderCall({ command: "done" }, plainTheme, ctx), component);
	assert.equal(textOf(component), "$ done");
});

test("job commands wrap without clipping at narrow and wide widths", () => {
	const command = 'cd project && uv run build.py --target production\nprintf "测试完成\\n"';
	const styledTheme = { fg: (_color, text) => `\x1b[33m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
	for (const width of [30, 80, 120]) {
		for (const theme of [plainTheme, styledTheme]) {
			const lines = renderCall({ command, timeout: 60 }, theme, context()).render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
			assert.equal(lines.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), `$ ${command} (timeout 60s)`.replace(/\s+/g, ""));
		}
	}
});
