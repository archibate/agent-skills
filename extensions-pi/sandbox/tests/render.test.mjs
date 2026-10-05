import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parsePermissions } from "../permissions.ts";
import { createSandboxBashDefinition, renderAllowanceBadge, renderBadge, renderSandboxCall } from "../tool.ts";

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const context = () => ({ toolCallId: "render", state: {}, executionStarted: false, lastComponent: undefined });
const textOf = (component, width = 120) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

test("shared call renderer shows command, timeout, and declared access", () => {
	const args = {
		command: "uv sync",
		timeout: 60,
		sandbox: { writableLocations: ["src", "~/.cache/uv"], networkAccess: "fetch-only" },
	};
	const rendered = renderSandboxCall(args, plainTheme, context());
	assert.equal(textOf(rendered), "$ uv sync (timeout 60s)\n⛶ rw src, ~/.cache/uv · net fetch-only");
	assert.equal(textOf(renderSandboxCall({ command: "git log" }, plainTheme, context())), "$ git log\n⛶ read-only");
	assert.equal(
		textOf(renderSandboxCall({ command: "pi -p", sandbox: { dangerouslySkipSandbox: true } }, plainTheme, context())),
		"$ pi -p\n⛶ UNSANDBOXED",
	);
});

test("partial calls reuse the previous component and update the access badge", () => {
	const ctx = context();
	const partial = renderSandboxCall({}, plainTheme, ctx);
	assert.equal(textOf(partial), "$ ...\n⛶ read-only");
	ctx.lastComponent = partial;
	const updated = renderSandboxCall({ command: "curl x", sandbox: { networkAccess: "full" } }, plainTheme, ctx);
	assert.equal(updated, partial);
	assert.equal(textOf(updated), "$ curl x\n⛶ read-only · net FULL");
});

test("wrapping fits narrow and wide terminals, multiline commands, CJK, and styled text", () => {
	const args = {
		command: 'cd project && uv run build.py --target production\nprintf "测试完成\\n"',
		sandbox: { writableLocations: ["/work/project", "~/.cache/uv"], networkAccess: "fetch-only" },
	};
	const styledTheme = { fg: (_color, text) => `\x1b[33m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
	for (const width of [30, 80, 120]) {
		for (const theme of [plainTheme, styledTheme]) {
			const lines = renderSandboxCall(args, theme, context()).render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
			assert.equal(
				lines.map(stripVTControlCharacters).join("").replace(/\s+/g, ""),
				`$ ${args.command}⛶ rw /work/project, ~/.cache/uv · net fetch-only`.replace(/\s+/g, ""),
				"wrapping loses no command or grant text",
			);
		}
	}
});

test("permission badge uses every call-badge grant and includes allowed tools", () => {
	const request = {
		writableLocations: ["/work"], networkAccess: "full", socketAccess: ["/run/s"],
		sessionBusAccess: true, displayAccess: true, processAccess: "signalling", deviceAccess: "gpu",
	};
	const allowance = parsePermissions(JSON.stringify({ ...request, tools: ["mcp_search"] }), "/work", "/home/u");
	assert.equal(renderAllowanceBadge(allowance, plainTheme), `${renderBadge(request, plainTheme)} · tools mcp_search`);
	assert.match(renderAllowanceBadge({ ...allowance, tools: "all" }, plainTheme), /· tools all$/);
	assert.equal(renderAllowanceBadge(parsePermissions("read-only", "/work", "/home/u"), plainTheme), "⛶ read-only");
	assert.equal(renderAllowanceBadge({ ...allowance, policy: { ...allowance.policy, skip: true } }, plainTheme), "⛶ UNSANDBOXED");
});

test("bash keeps its execution timer while sharing the call renderer", () => {
	const bash = createSandboxBashDefinition("/work");
	const ctx = context();
	ctx.executionStarted = true;
	const args = { command: "build", timeout: 10, sandbox: { writableLocations: ["src"] } };
	const component = bash.renderCall(args, plainTheme, ctx);
	const startedAt = ctx.state.startedAt;
	assert.equal(typeof startedAt, "number");
	assert.deepEqual(component.render(80), renderSandboxCall(args, plainTheme, context()).render(80));
	ctx.lastComponent = component;
	ctx.state.endedAt = startedAt + 100;
	assert.equal(bash.renderCall(args, plainTheme, ctx), component);
	assert.equal(ctx.state.startedAt, startedAt);
	assert.equal(ctx.state.endedAt, startedAt + 100);
});
