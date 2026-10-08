import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

// Only synthetic transcripts and an in-memory session manager. No Pi process,
// model requests, terminal writes, live config, or persisted user sessions.
const base = process.env.PI_SCRATCHPAD_DIR;
assert.ok(base, "Set PI_SCRATCHPAD_DIR to an agent-owned test workspace");
const scratch = mkdtempSync(join(base, "context-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let host = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(host, "package.json"))) {
	const versionFile = join(host, "install/current-version");
	if (existsSync(versionFile)) {
		host = join(host, "install/releases", readFileSync(versionFile, "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
		break;
	}
	if (dirname(host) === host) throw new Error("Could not locate Pi's installed package");
	host = dirname(host);
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR"]) {
	process.env[key] = join(scratch, key);
	mkdirSync(process.env[key], { recursive: true });
}
process.env.JITI_FS_CACHE = "false";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(scratch, "context.ts");
copyFileSync(join(root, "extensions-pi/context/index.ts"), extensionPath);
mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["pi-coding-agent", "pi-tui"]) {
	symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
}
const { createJiti } = await import(join(host, "dist/core/extensions/jiti-loader.js"));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { default: contextExtension, collectConversation, allocateStats, rankTools, collectReport, renderLines } = await jiti.import(extensionPath);
const { estimateTokens, SessionManager } = await import(join(host, "dist/index.js"));
const { loadExtensions } = await import(join(host, "dist/core/extensions/loader.js"));
const { visibleWidth } = await import(join(host, "../pi-tui/dist/index.js"));

const palette = { fg: (_color, text) => text, bold: (text) => text, swatch: () => "•" };
const ansiPalette = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m`, swatch: () => "\x1b[32m■\x1b[39m" };
const theme = { fg: ansiPalette.fg, bold: ansiPalette.bold };
const sum = (items) => items.reduce((n, item) => n + item.tokens, 0);
const projection = (messages) => ({ entries: messages.map((message) => ({ messages: [message] })) });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });
const call = (name, args = {}) => ({ type: "toolCall", id: `id-${name}`, name, arguments: args });
const assistant = (...content) => ({ role: "assistant", content, timestamp: 1, api: "openai-responses", provider: "test", model: "test", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const result = (toolName, content, extra = {}) => ({ role: "toolResult", toolName, toolCallId: `id-${toolName}`, content, isError: false, timestamp: 1, ...extra });
function child(stat, ...labels) {
	for (const label of labels) stat = stat?.children?.find((item) => item.label === label);
	return stat;
}
function conserved(stats, expected = sum(stats)) {
	assert.equal(sum(stats), expected);
	for (const stat of stats) {
		assert.ok(Number.isInteger(stat.tokens) && stat.tokens >= 0, JSON.stringify(stat));
		if (stat.children) conserved(stat.children, stat.tokens);
	}
}
const pi = { getActiveTools: () => [], getAllTools: () => [] };
function context(messages = [], tokens = null, extra = {}) {
	return {
		model: { provider: "fixture", id: "model", contextWindow: 10000 },
		getContextUsage: () => ({ tokens, contextWindow: 10000 }),
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({}),
		sessionManager: { buildSessionProjection: () => projection(messages) },
		mode: "print", hasUI: false,
		ui: { notify: (message) => assert.fail(message) },
		...extra,
	};
}
const toolNames = ["bash", "read", "write", "mcp.one.lookup", "mcp.two.lookup", "retired", "工具.搜索👩‍💻", "alpha"];
const messages = [user("hello"), assistant(thinking("r".repeat(35)), text("answer"))];
for (const [i, name] of toolNames.entries()) {
	messages.push(assistant(call(name, { input: "x".repeat((i + 1) * 40) })));
	messages.push(result(name, [text("r".repeat((toolNames.length - i) * 100))]));
}
messages.push(assistant(call("read", { path: "again" }), call("bash", { command: "true" })));
messages.push(result("read", [text("more")], { isError: true }));

// The real extension loader loads only our explicit copied file and registers
// the command; the runtime tool inventory is mocked before command invocation.
test("installed Pi loader accepts the extension", async () => {
	const loaded = await loadExtensions([extensionPath], scratch);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.ok(loaded.extensions[0].commands.has("context"));
	loaded.runtime.getActiveTools = pi.getActiveTools;
	loaded.runtime.getAllTools = pi.getAllTools;
	let output;
	await loaded.extensions[0].commands.get("context").handler("", context(messages, null, {
		hasUI: true,
		ui: { editor: async (_title, value) => { output = value; }, notify: assert.fail },
	}));
	assert.match(output, /      • Tool calls/);
	assert.doesNotMatch(output, /Tool calls \(8\)|Tool results \(8\)/);
});

test("assistant block estimates conserve whole-message rounding", () => {
	const mixed = assistant(thinking("a"), text("b"), call("read", { path: "x" }), call("read", { path: "y" }), call("bash"));
	const stats = collectConversation(projection([mixed]));
	assert.equal(stats.tokens, estimateTokens(mixed));
	assert.equal(child(stats, "Assistant").tokens, estimateTokens(mixed));
	const calls = child(stats, "Assistant", "Tool calls");
	assert.equal(calls.children.length, 2);
	assert.equal(calls.detail, "calls");
	conserved([stats]);
	// Independent block rounding would incorrectly make these two tokens.
	const tiny = collectConversation(projection([assistant(thinking("a"), text("b"))]));
	assert.equal(tiny.tokens, 1);
	conserved([tiny]);
});

test("tool names, errors, images count once; metadata and hidden reasoning do not", () => {
	const image = { type: "image", data: "not-a-real-image", mimeType: "image/png" };
	const visible = assistant(thinking("visible"), text("hello"), call("historical.server.tool", { a: 1 }));
	visible.content[0].thinkingSignature = "opaque".repeat(1000);
	visible.content[1].textSignature = "opaque".repeat(1000);
	visible.usage.reasoning = 999999;
	const output = result("historical.server.tool", [text("error"), image], {
		isError: true, details: { giant: "d".repeat(10000) }, usage: { totalTokens: 99999 },
		nestedCalls: { calls: [{ name: "not-in-transcript", arguments: { large: "a".repeat(10000) } }] },
	});
	const hidden = assistant({ ...thinking(""), redacted: true, thinkingSignature: "encrypted".repeat(10000) });
	hidden.usage.reasoning = 900000;
	const stats = collectConversation(projection([visible, output, hidden, assistant(), result("empty-tool", [])]));
	assert.equal(child(stats, "Assistant", "Reasoning").tokens, 2);
	assert.equal(child(stats, "Tool results").tokens, estimateTokens(output));
	assert.equal(child(stats, "Tool results").tokens, 1202);
	assert.equal(child(stats, "Tool results").children.length, 2);
	assert.equal(child(stats, "Assistant", "Tool calls").children[0].label, "historical.server.tool");
	assert.equal(stats.tokens, estimateTokens(visible) + estimateTokens(output));
	assert.doesNotMatch(JSON.stringify(stats), /not-in-transcript/);
	assert.deepEqual(collectConversation(projection([hidden, assistant()])).children, []);
	conserved([stats]);
});

test("user images, bash/custom messages, and both summary roles retain their categories", () => {
	const input = [
		user([text("hello"), { type: "image", data: "fixture", mimeType: "image/png" }]),
		{ role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0 },
		{ role: "custom", content: "custom text", details: { ignored: "large".repeat(1000) } },
		{ role: "branchSummary", summary: "branch summary" },
		{ role: "compactionSummary", summary: "compaction summary" },
	];
	const stats = collectConversation(projection(input));
	assert.equal(child(stats, "User").tokens, estimateTokens(input[0]));
	assert.equal(child(stats, "Other").tokens, estimateTokens(input[1]) + estimateTokens(input[2]));
	assert.equal(child(stats, "Summaries").tokens, estimateTokens(input[3]) + estimateTokens(input[4]));
	assert.equal(child(stats, "Assistant"), undefined);
	conserved([stats]);
});

test("complete independent rankings preserve totals, repeated names, and qualified names", () => {
	const stats = collectConversation(projection(messages));
	const calls = child(stats, "Assistant", "Tool calls");
	const results = child(stats, "Tool results");
	assert.equal(calls.children.length, 8);
	assert.equal(results.children.length, 8);
	assert.equal(rankTools(calls.children)[0].label, "alpha");
	assert.equal(rankTools(results.children)[0].label, "bash");
	for (const group of [calls, results]) {
		const ranked = rankTools(group.children);
		assert.equal(ranked.length, 8);
		assert.equal(sum(ranked), group.tokens);
		assert.ok(ranked.every((item) => item.label !== "Other tools"));
	}
	assert.ok(calls.children.some((item) => item.label === "mcp.one.lookup"));
	assert.ok(calls.children.some((item) => item.label === "mcp.two.lookup"));
	assert.deepEqual(rankTools([{ label: "z", tokens: 1 }, { label: "a", tokens: 1 }]).map((item) => item.label), ["a", "z"]);
});

test("recursive allocation across fractional scales, tiny totals, and zero", async () => {
	const raw = collectConversation(projection(messages));
	for (const total of [0, 1, 2, 3, 7, 17, 101, 3001, 9876]) {
		const stats = allocateStats([raw], total);
		conserved(stats, total);
		const calls = child(stats[0], "Assistant", "Tool calls");
		assert.equal(sum(rankTools(calls.children)), calls.tokens);
		const report = await collectReport(context(messages, total, { getSystemPrompt: () => "system" }), pi, false, false);
		conserved(report.stats, total);
		assert.equal(report.used, total);
	}
	// Deterministic fractional-weight trees exercise every recursive level.
	for (let seed = 1; seed <= 50; seed++) {
		const leaves = Array.from({ length: 8 }, (_, i) => ({ label: `tool${i}`, tokens: ((seed * (i + 3)) % 37) + 0.25, color: "accent" }));
		const tree = [
			{ label: "a", tokens: sum(leaves), color: "accent", children: leaves },
			{ label: "b", tokens: seed / 7, color: "accent" },
		];
		conserved(allocateStats(tree, seed), seed);
	}
	assert.deepEqual(allocateStats([], 0), []);
	const zero = await collectReport(context([], 0), pi, false, false);
	assert.deepEqual(zero.stats, []);
	assert.equal(zero.free, zero.window);
	const unattributed = await collectReport(context([], 7), pi, false, false);
	assert.equal(unattributed.stats[0].label, "Unattributed");
	conserved(unattributed.stats, 7);
	const unknown = await collectReport(context(messages), pi, false, false);
	assert.equal(unknown.usedKnown, false);
	assert.equal(unknown.used, messages.reduce((n, message) => n + estimateTokens(message), 0));
	conserved(unknown.stats, unknown.used);
	const unavailable = await collectReport(context(messages, null, { getContextUsage: () => undefined }), pi, false, false);
	assert.equal(unavailable.used, unknown.used);
	assert.equal(unavailable.window, 10000);
});

test("existing system/files/skills/declaration categories remain separate", async () => {
	const ctx = context([{ role: "system", content: "base", sections: { project_context: "project", skills: "skills" } }, ...messages], 2500, {
		getSystemPromptOptions: () => ({
			contextFiles: [{ path: "/fixture/AGENTS.md", content: "instructions" }],
			skills: [{ name: "fixture", description: "a skill", filePath: "/fixture/SKILL.md" }],
		}),
	});
	const tools = { getActiveTools: () => ["read", "server.search"], getAllTools: () => [
		{ name: "read", description: "read text", parameters: {} },
		{ name: "server.search", description: "search", parameters: {}, namespace: { name: "server" } },
		{ name: "inactive", description: "ignored", parameters: {} },
	] };
	const report = await collectReport(ctx, tools, true, true);
	assert.deepEqual(report.stats.map((stat) => stat.label), ["System prompt", "Context files", "Skills", "Tool definitions", "MCP tool definitions", "Messages"]);
	assert.equal(report.tools.length, 2);
	assert.equal(report.files.length, 1);
	assert.equal(report.skills.length, 1);
	conserved(report.stats, 2500);
	const rendered = renderLines(report, palette, 100).join("\n");
	assert.ok(rendered.indexOf("Tool definitions (2)") < rendered.indexOf("Tool calls (8)"));
});

test("real in-memory projection respects compaction, branches, and context edits", () => {
	const session = SessionManager.inMemory(scratch);
	const start = session.appendMessage(user("root"));
	session.appendMessage(assistant(call("abandoned")));
	session.appendMessage(result("abandoned", [text("gone")]));
	session.branch(start);
	session.appendMessage(assistant(call("compacted")));
	session.appendMessage(result("compacted", [text("gone")]));
	const kept = session.appendMessage(user("kept"));
	const callId = session.appendMessage(assistant(thinking("old reason"), call("before-edit")));
	const outputId = session.appendMessage(result("before-edit", [text("old result")]));
	session.appendCompaction("summary", kept, 5000);
	session.appendContextEdit(callId, { content: [text("new text"), call("after-edit")] });
	session.appendContextEdit(outputId, null);
	session.appendMessage(result("after-edit", [text("new result")]));
	session.appendCustomEntry("ignored-state", { content: "x".repeat(1000) });
	session.appendCustomMessageEntry("visible-custom", "custom content", false);
	const projected = session.buildSessionProjection();
	const stats = collectConversation(projected);
	assert.equal(child(stats, "Assistant", "Tool calls").children[0].label, "after-edit");
	assert.equal(child(stats, "Tool results").children[0].label, "after-edit");
	assert.equal(child(stats, "Summaries").tokens, 2);
	assert.equal(child(stats, "Other").tokens, 4);
	assert.equal(child(stats, "Assistant", "Reasoning"), undefined);
	assert.doesNotMatch(JSON.stringify(stats), /abandoned|compacted|before-edit/);
	assert.equal(stats.tokens, projected.messages.filter((message) => message.role !== "system").reduce((n, message) => n + estimateTokens(message), 0));
	assert.equal(session.getSessionFile(), undefined);
	conserved([stats]);
	// Replacing result content must replace, not add to, its token contribution.
	const last = session.appendMessage(result("after-edit", [text("x".repeat(1000))]));
	session.appendContextEdit(last, { content: [text("tiny")] });
	assert.equal(child(collectConversation(session.buildSessionProjection()), "Tool results").tokens, child(stats, "Tool results").tokens + 1);
});

function command(inventory = pi) {
	let registered;
	contextExtension({ ...inventory, registerCommand: (name, value) => { assert.equal(name, "context"); registered = value; } });
	return registered.handler;
}

test("flags, aliases, separate detail sections, and plain-text routes", async () => {
	const invoke = command({ getActiveTools: () => ["fixture-tool"], getAllTools: () => [{ name: "fixture-tool", description: "fixture", parameters: {} }] });
	for (const [flag, full, skills] of [["", false, false], ["tools", true, false], ["skills", false, true], ["all", true, true], ["verbose", true, true], ["-v", true, true], ["TOOLS SKILLS", true, true]]) {
		let output;
		const ctx = context(messages, null, { hasUI: true, getSystemPromptOptions: () => ({ skills: [{ name: "test-skill", description: "test", filePath: "/fixture/SKILL.md" }] }), ui: { editor: async (_title, value) => { output = value; }, notify: assert.fail } });
		await invoke(flag, ctx);
		assert.ok(output);
		assert.equal(output.includes("Skills (1)"), skills, flag);
		assert.equal(output.includes("Tool definitions (1)"), full, flag);
		if (!flag) writeFileSync(join(base, "context-render-default.txt"), output);
		assert.doesNotMatch(output, /Other tools/);
		assert.equal(output.includes("Tool calls (8)"), full, flag);
		assert.equal(output.includes("Tool results (8)"), full, flag);
		if (full) {
			for (const name of toolNames) assert.ok(output.includes(name), `${flag}: ${name}`);
		}
		const overview = full ? output.slice(0, output.indexOf("Tool calls (8)")) : output;
		assert.match(overview, /      • Reasoning/);
		assert.match(overview, /      • Text/);
		assert.match(overview, /      • Tool calls/);
		assert.match(overview, /    • Tool results/);
		for (const name of toolNames) assert.ok(!overview.includes(name), name);
		assert.doesNotMatch(output, /provider total|authoritative/);
	}
	const oldLog = console.log;
	let printed;
	try {
		console.log = (value) => { printed = value; };
		await invoke("", context(messages));
	} finally { console.log = oldLog; }
	assert.match(printed, /Context usage unknown/);
	assert.match(printed, /    • Tool results/);
	assert.doesNotMatch(printed, /Tool calls \(8\)|Tool results \(8\)/);
});

test("render matrix: widths, ANSI, wide names, numeric columns, empty states", async () => {
	const report = await collectReport(context(messages, 5000), pi, true, true);
	const resultGroup = child(report.stats.find((stat) => stat.label === "Messages"), "Tool results");
	resultGroup.children[0].label = "very.long.qualified.namespace.工具.👩‍💻.e\u0301.".repeat(4);
	for (const width of [24, 32, 48, 80, 100, 160]) {
		for (const colors of [palette, ansiPalette]) {
			const lines = renderLines(report, colors, width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
			const percentageRows = lines.filter((line) => /\d+\.\d+%\s*$/.test(line));
			assert.ok(percentageRows.length >= 8);
			assert.ok(percentageRows.every((line) => visibleWidth(line.trimEnd()) === width - 2), `misaligned percentage at ${width}`);
			for (const header of ["Tool calls (8)", "Tool results (8)"]) {
				const start = lines.findIndex((line) => line.includes(header));
				assert.ok(start >= 0);
				const rows = lines.slice(start + 1, start + 9);
				assert.equal(rows.length, 8);
				assert.ok(rows.every((line) => /\d(?:\.\d)?k?\s*$/.test(line)));
				assert.ok(rows.every((line) => visibleWidth(line.trimEnd()) === width - 2));
			}
			assert.ok(lines.every((line) => !line.includes("\ufffd")));
			if (width >= 32) assert.ok(lines.some((line) => line.includes("Reasoning")));
			if (colors === palette) writeFileSync(join(base, `context-render-${width}.txt`), lines.join("\n"));
		}
	}
	for (const tokens of [0, null]) {
		const empty = await collectReport(context([], tokens), pi, false, false);
		assert.doesNotMatch(renderLines(empty, palette, 80).join("\n"), /Tool calls|Tool results|Reasoning/);
	}
	const noModel = await collectReport(context([], null, { model: undefined, getContextUsage: () => undefined }), pi, false, false);
	assert.match(renderLines(noModel, palette, 80).join("\n"), /No context window available/);
});

test("fake-terminal pager scrolls, resizes, and closes without touching the TTY", async () => {
	for (const close of ["\x1b", "\r", "q", "\x03"]) {
		let component;
		let done = false;
		let renders = 0;
		const tui = { terminal: { rows: 20 }, requestRender: () => { renders++; } };
		const ctx = context(messages, 5000, { mode: "tui", hasUI: true, ui: {
			notify: assert.fail,
			custom: async (factory, options) => {
				assert.equal(options.overlay, true);
				component = factory(tui, theme, {}, () => { done = true; });
				const first = component.render(80);
				assert.equal(first.length, 16);
				component.handleInput("\x1b[B");
				assert.notDeepEqual(component.render(80), first);
				component.handleInput("\x1b[A");
				assert.deepEqual(component.render(80), first);
				component.handleInput("\x1b[6~");
				assert.notDeepEqual(component.render(80), first);
				component.handleInput("\x1b[5~");
				assert.deepEqual(component.render(80), first);
				component.handleInput("\x1b[F");
				const end = component.render(80);
				assert.notDeepEqual(end, first);
				component.handleInput("\x1b[B");
				assert.deepEqual(component.render(80), end);
				tui.terminal.rows = 100;
				assert.ok(component.render(48).every((line) => visibleWidth(line) <= 48));
				tui.terminal.rows = 20;
				component.handleInput("\x1b[H");
				assert.deepEqual(component.render(80), first);
				component.invalidate();
				const before = renders;
				component.handleInput("x");
				assert.equal(renders, before);
				component.handleInput(close);
			},
		} });
		await command()("all", ctx);
		assert.ok(done);
		assert.ok(renders >= 6);
	}
});
