import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import jobsExtension from "../index.ts";
import { createJobToolRenderers } from "../renderers.ts";

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
	assert.match(collapsed, /^job 132f "renderer" · exit 0\n/);
	assert.match(collapsed, /15 earlier lines/);
	assert.match(collapsed, /line 16\nline 17\nline 18\nline 19\nline 20$/);
	assert.doesNotMatch(collapsed, /\[job\]|line 1\n/);
	assert.equal(textOf(renderMessage(message, { expanded: true, outputPad: 0 }, plainTheme)).trim(), content.replace('[job 132f "renderer"] exit 0', 'job 132f "renderer" · exit 0'));
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
	assert.equal(textOf(component).split("\n").map((line) => line.trim()).join("\n").trim(), content.replace("[job click] exit 0", "job click · exit 0"));
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
	for (const [content, expected] of [
		["", ""],
		["[job abc] exit 0", "job abc · exit 0"],
		["[job abc]\nready", "job abc\nready"],
		['[job abc "name [with brackets]"] finished: exit 0', 'job abc "name [with brackets]" · exit 0'],
		["Liveness check: still running", "Liveness check: still running"],
		[[{ type: "text", text: "[job abc] exit 0" }, { type: "text", text: "ready" }], "job abc · exit 0\nready"],
	]) {
		const message = { customType: "job", content, display: true };
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
			assert.equal(expanded.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), message.content.replace('[job abc "long name"] exit 0', 'job abc "long name" · exit 0').replace(/\s+/g, ""));
		}
	}
});

test("jobs owns its command renderer without sandbox", () => {
	assert.equal(textOf(renderCall({ command: "uv sync", name: "build", timeout: 60 }, plainTheme, context())), "job start \"build\" · timeout 60s\n  $ uv sync");
	assert.equal(textOf(renderCall({ command: "git log" }, plainTheme, context())), "job start\n  $ git log");
});

test("watch and stop calls share explicit action headers and effective defaults", () => {
	const watch = tools.get("job_watch").renderCall;
	const stop = tools.get("job_stop").renderCall;
	assert.equal(textOf(watch({ id: "132f", pattern: "error", timeout: 120 }, plainTheme, context())), "job watch 132f · /error/i · 120s");
	assert.equal(textOf(watch({ id: "132f" }, plainTheme, context())), "job watch 132f · 600s");
	assert.equal(textOf(watch({ id: "132f", timeout: 5000 }, plainTheme, context())), "job watch 132f · 3600s");
	assert.equal(textOf(watch({ id: "132f", timeout: 0.5, pattern: "" }, plainTheme, context())), "job watch 132f · //i · 1s");
	assert.equal(textOf(stop({ id: "132f" }, plainTheme, context())), "job stop 132f · SIGTERM");
	assert.equal(textOf(stop({ id: "132f", signal: "SIGKILL" }, plainTheme, context())), "job stop 132f · SIGKILL");
	assert.equal(textOf(watch({}, plainTheme, context())), "job watch ... · 600s");
	assert.equal(textOf(stop({}, plainTheme, context())), "job stop ... · SIGTERM");
	for (const renderer of [watch, stop]) {
		const ctx = context();
		ctx.lastComponent = renderer({}, plainTheme, ctx);
		assert.equal(renderer({ id: "132f" }, plainTheme, ctx), ctx.lastComponent);
	}
});

test("watch and stop show the job's name beside its ID and retain it across redraws", () => {
	for (const action of ["watch", "stop"]) {
		const names = new Map([["132fdead", 'build "测试"']]);
		const renderer = createJobToolRenderers(action, { jobName: (id) => names.get(id), watchTimeoutSeconds: () => 600 }).renderCall;
		const ctx = context();
		const suffix = action === "watch" ? "600s" : "SIGTERM";
		const expected = `job ${action} 132fdead ${JSON.stringify('build "测试"')} · ${suffix}`;
		const component = renderer({ id: "132fdead" }, plainTheme, ctx);
		assert.equal(textOf(component), expected);
		for (const width of [20, 80, 120]) {
			const lines = component.render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
			assert.equal(lines.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), expected.replace(/\s+/g, ""));
		}
		ctx.lastComponent = component;
		names.clear();
		assert.equal(textOf(renderer({ id: "132fdead" }, plainTheme, ctx)), expected, "retain a known name if the finished job leaves the registry");
		assert.equal(textOf(renderer({ id: "unknown" }, plainTheme, ctx)), `job ${action} unknown · ${suffix}`, "changing IDs never carries over another job's name");
		assert.equal(textOf(renderer({}, plainTheme, ctx)), `job ${action} ... · ${suffix}`);
		names.set("unnamed", "");
		assert.equal(textOf(renderer({ id: "unnamed" }, plainTheme, ctx)), `job ${action} unnamed · ${suffix}`);
	}
});

test("all action headers wrap without losing names, filters, IDs, or signals", () => {
	const fixtures = [
		["job_start", { name: 'build "测试"', command: "uv run build.py\nprintf done", timeout: 60 }, 'job start "build \\"测试\\"" · timeout 60s\n  $ uv run build.py\n  printf done'],
		["job_watch", { id: "132fdead", pattern: "error|测试完成", timeout: 120 }, "job watch 132fdead · /error|测试完成/i · 120s"],
		["job_stop", { id: "132fdead", signal: "SIGKILL" }, "job stop 132fdead · SIGKILL"],
	];
	const styledTheme = { ...plainTheme, fg: (_color, text) => `\x1b[33m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
	for (const [toolName, args, expected] of fixtures) {
		for (const theme of [plainTheme, styledTheme]) {
			for (const width of [20, 80, 120]) {
				const lines = tools.get(toolName).renderCall(args, theme, context()).render(width);
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
				assert.equal(lines.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), expected.replace(/\s+/g, ""));
			}
		}
	}
});

test("tool results use verified compact outcomes and expand to original details", () => {
	const options = { expanded: false, isPartial: false };
	for (const [toolName, details, content, expected] of [
		["job_start", { id: "132f", pid: 12345, dir: "/private/logs" }, 'Started job 132f (pgid 12345). Dir: /private/logs (stdout, stderr, status inside). You will be notified when it exits.', "started 132f · pgid 12345"],
		["job_watch", { id: "132f" }, 'Watching job 132f. Recent output is replayed, then new matching lines arrive as messages.', "watching"],
		["job_stop", { id: "132f", summary: "stopped: killed by SIGTERM" }, 'job 132f stopped: killed by SIGTERM', "stopped: killed by SIGTERM"],
		["job_stop", { id: "132f", summary: "sent SIGTERM; still running after 3s" }, 'Sent SIGTERM to job 132f; it is still running after 3s. Retry with signal "SIGKILL" to force.', "sent SIGTERM; still running after 3s"],
		["job_stop", { id: "132f", summary: "already finished: exit 0" }, 'job 132f already finished: exit 0', "already finished: exit 0"],
		["job_stop", { id: "132f", summary: "sent SIGTERM to remaining processes · pgid 12345" }, 'Sent SIGTERM to the processes job 132f left running (process group 12345).', "sent SIGTERM to remaining processes · pgid 12345"],
	]) {
		const result = { content: [{ type: "text", text: content }], details };
		const renderer = tools.get(toolName).renderResult;
		assert.equal(textOf(renderer(result, options, plainTheme, context())), `→ ${expected}`);
		const full = textOf(renderer(result, { ...options, expanded: true }, plainTheme, context())).replace(/\s+/g, "");
		assert.equal(full, `→ ${content}`.replace(/\s+/g, ""));
		assert.equal(result.content[0].text, content);
	}
});

test("errors, pending results, and legacy details never invent a successful outcome", () => {
	for (const [toolName, pending] of [["job_start", "starting"], ["job_watch", "watching"], ["job_stop", "stopping"]]) {
		const renderer = tools.get(toolName).renderResult;
		const result = { content: [{ type: "text", text: "Failed to run job" }], details: { id: "132f", pid: 1, summary: "stopped" } };
		assert.equal(textOf(renderer(result, { expanded: false, isPartial: false }, plainTheme, { ...context(), isError: true })), "→ Failed to run job");
		assert.equal(textOf(renderer({ content: [], details: result.details }, { expanded: false, isPartial: true }, plainTheme, context())), `→ ${pending}...`);
		assert.equal(textOf(renderer({ content: [{ type: "text", text: "Legacy result" }] }, { expanded: false, isPartial: false }, plainTheme, context())), "→ Legacy result");
	}
});

test("collapsed result errors stay within five visual lines at narrow widths", () => {
	const result = { content: [{ type: "text", text: "very long 错误 ".repeat(100) }] };
	for (const toolName of ["job_start", "job_watch", "job_stop"]) {
		const renderer = tools.get(toolName).renderResult;
		const component = renderer(result, { expanded: false, isPartial: false }, plainTheme, { ...context(), isError: true });
		for (const width of [20, 80, 120, 20]) {
			const lines = component.render(width);
			assert.ok(lines.length <= 6);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
			assert.match(lines.map(stripVTControlCharacters).join("\n"), /more/);
			component.invalidate();
			assert.deepEqual(component.render(width), lines);
		}
	}
});

test("partial job calls reuse and update their component", () => {
	const ctx = context();
	const component = renderCall({}, plainTheme, ctx);
	assert.equal(textOf(component), "job start\n  $ ...");
	ctx.lastComponent = component;
	assert.equal(renderCall({ command: "build", timeout: 30 }, plainTheme, ctx), component);
	assert.equal(textOf(component), "job start · timeout 30s\n  $ build");
	assert.equal(renderCall({ command: "done" }, plainTheme, ctx), component);
	assert.equal(textOf(component), "job start\n  $ done");
});

test("job commands wrap without clipping at narrow and wide widths", () => {
	const command = 'cd project && uv run build.py --target production\nprintf "测试完成\\n"';
	const styledTheme = { fg: (_color, text) => `\x1b[33m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
	for (const width of [30, 80, 120]) {
		for (const theme of [plainTheme, styledTheme]) {
			const lines = renderCall({ command, timeout: 60 }, theme, context()).render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
			assert.equal(lines.map(stripVTControlCharacters).join("").replace(/\s+/g, ""), `job start · timeout 60s\n  $ ${command}`.replace(/\s+/g, ""));
		}
	}
});
