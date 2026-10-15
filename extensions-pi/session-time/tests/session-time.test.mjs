import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent, InteractiveMode, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import sessionTime, { register, statusText } from "../index.ts";
import { SUMMARY, insertTime } from "../presentation.ts";
import { ENTRY_TYPE, RunTracker, formatDuration, sumEntries } from "../tracker.ts";
import rmb from "../../rmb-cost/index.ts";
import subagentCost from "../../subagent-cost/index.ts";

initTheme("dark", false);
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { setTheme } = await import(new URL("modes/interactive/theme/theme.js", sdk));
const noopApi = { on() {}, registerToolRenderer() {}, appendEntry() {} };
const timeFirst = process.env.TIME_LOAD_ORDER !== "cost-first";
async function loadAll() {
	if (timeFirst) sessionTime(noopApi);
	subagentCost(noopApi);
	await rmb(noopApi);
	if (!timeFirst) sessionTime(noopApi);
}
await loadAll();
const textOf = (component, width = 160) => component.render(width).map((line) => plain(line).trimEnd()).join("\n");

function clock(start = 1000) {
	const c = () => c.t;
	c.t = start;
	return c;
}

/** Fake pi + ctx driving the real extension handlers. */
function harness({ mode = "tui", entries = [] } = {}) {
	const handlers = new Map();
	const appended = [];
	const statuses = [];
	const manager = SessionManager.inMemory("/workspace");
	for (const data of entries) manager.appendCustomEntry(ENTRY_TYPE, data);
	const api = {
		on: (name, handler) => handlers.set(name, handler),
		appendEntry: (customType, data) => { appended.push(data); manager.appendCustomEntry(customType, data); },
	};
	const now = clock();
	register(api, now);
	const ctx = { mode, sessionManager: manager, ui: { setStatus: (key, text) => statuses.push([key, text]), theme: { fg: (_c, t) => t } } };
	const emit = (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	return { emit, now, appended, statuses, manager, last: () => statuses.at(-1)?.[1] };
}

function withFakeIntervals(fn) {
	const live = new Set();
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	globalThis.setInterval = (cb) => { const id = { cb, unref() {} }; live.add(id); return id; };
	globalThis.clearInterval = (id) => live.delete(id);
	try { return fn(live); } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
}

const T = (activeMs = 0, apiMs = 0, toolMs = 0, requests = 0, toolCalls = 0) => ({ activeMs, apiMs, toolMs, requests, toolCalls });
const zeroRun = { apiMs: 0, toolMs: 0, requests: 0, toolCalls: 0 };

test("tracker pauses on prompts, ignores double start, stray ends and idle settle", () => {
	const now = clock();
	const t = new RunTracker(now);
	assert.equal(t.settle(), undefined);
	t.promptEnd();
	assert.equal(t.start(), true);
	now.t += 5000;
	assert.equal(t.start(), false);
	t.promptStart(); t.promptStart();
	now.t += 60000;
	t.promptEnd();
	assert.equal(t.waiting, true, "nested prompt still open");
	now.t += 1000;
	t.promptEnd();
	assert.equal(t.waiting, false);
	now.t += 2000;
	assert.equal(t.snapshot().activeMs, 7000);
	assert.equal(t.settle().activeMs, 7000);
	assert.equal(t.running, false);
	// A run that starts under an open dialog starts paused.
	t.promptStart();
	t.start();
	now.t += 3000;
	assert.equal(t.snapshot().activeMs, 0);
	t.promptEnd();
	now.t += 1000;
	assert.equal(t.settle().activeMs, 1000);
});

test("tracker splits api, union of parallel/nested tools, pauses and other; ignores warm requests", () => {
	const now = clock();
	const t = new RunTracker(now);
	t.toolStart("idle", false); t.turnStart(); t.requestStart(); // Ignored while idle.
	t.start();
	t.requestStart(); // Cache warm before the first turn.
	now.t += 1000; // other
	t.turnStart();
	t.requestStart();
	now.t += 4000;
	t.requestStart(); // Provider retry inside the same request.
	now.t += 1000;
	t.requestEnd();
	now.t += 500; // other
	t.toolStart("a", false); t.toolStart("b", false); t.toolStart("n", true); t.toolStart("a", false);
	t.requestStart(); // Cache warm during a long tool: no message_end follows.
	now.t += 2000;
	t.toolEnd("a");
	now.t += 1000;
	t.promptStart(); // Sandbox approval inside a tool.
	now.t += 9000;
	t.promptEnd();
	now.t += 1000;
	t.toolEnd("n"); t.toolEnd("b"); t.toolEnd("b");
	now.t += 500; // other, not api left open by the warm request
	t.turnStart();
	t.requestStart();
	now.t += 3000;
	t.requestEnd(); t.requestEnd();
	t.requestStart(); // Cache warm after the final reply, e.g. during settle hooks.
	now.t += 2000; // other
	assert.deepEqual(t.settle(), T(16000, 8000, 4000, 2, 2));
});

test("duration format boundaries", () => {
	assert.equal(formatDuration(-5), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(59999), "59s");
	assert.equal(formatDuration(60000), "1m 00s");
	assert.equal(formatDuration(754000), "12m 34s");
	assert.equal(formatDuration(3599999), "59m 59s");
	assert.equal(formatDuration(3600000), "1h 00m");
	assert.equal(formatDuration(3733000), "1h 02m");
	assert.equal(formatDuration(100 * 3600000), "100h 00m");
});

test("sumEntries counts only valid session-time records and tolerates missing breakdowns", () => {
	const entries = [
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, activeMs: 1000, apiMs: 600, toolMs: 300, requests: 2, toolCalls: 1 } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, activeMs: 500, partial: true } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, activeMs: 100, apiMs: "x", toolMs: -5 } },
		{ type: "custom", customType: "other", data: { v: 1, activeMs: 9999 } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 2, activeMs: 9999 } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, activeMs: -1 } },
		{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, activeMs: Number.NaN } },
		{ type: "custom", customType: ENTRY_TYPE },
		{ type: "message", message: { role: "user" } },
	];
	assert.deepEqual(sumEntries(entries), { ...T(1600, 600, 300, 2, 1), runs: 3, last: T(100) });
});

test("event sequence persists runs, ticks status live and leaves no timer behind", () => withFakeIntervals((live) => {
	const h = harness({ entries: [{ v: 1, ...T(60000, 30000, 20000, 3, 2) }] });
	const assistant = { message: { role: "assistant" } };
	h.emit("session_start");
	assert.equal(h.last(), "⏱ 1m 00s · ■ ran 1m 00s", "last run restored from entries");
	h.emit("before_agent_start");
	h.emit("agent_start");
	assert.equal(live.size, 1, "one ticker per run");
	h.now.t += 2000;
	h.emit("turn_start");
	h.emit("before_provider_request", { payload: {} });
	h.now.t += 30000;
	h.emit("message_end", assistant);
	h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
	h.emit("before_provider_request", { payload: {} }); // Cache warm: ignored.
	h.now.t += 10000;
	[...live][0].cb();
	assert.equal(h.last(), "⏱ 1m 42s · ▶ running 42s");
	h.emit("ui_prompt_start");
	h.now.t += 600000;
	[...live][0].cb();
	assert.equal(h.last(), "⏱ 1m 42s · ⏸ waiting 42s");
	h.emit("ui_prompt_end");
	h.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", durationMs: 10000 });
	h.emit("message_end", { message: { role: "toolResult" } });
	h.emit("agent_end");
	h.now.t += 3000;
	h.emit("agent_start"); // Continuation inside the same run.
	h.emit("turn_start");
	h.emit("before_provider_request", { payload: {} });
	h.now.t += 5000;
	h.emit("message_end", assistant);
	h.emit("agent_settled", { aborted: false });
	assert.equal(live.size, 0);
	assert.deepEqual(h.appended, [{ v: 1, ...T(50000, 35000, 10000, 2, 1) }]);
	assert.equal(h.last(), "⏱ 1m 50s · ■ ran 50s");
	assert.deepEqual(h.manager[SUMMARY](), { total: T(110000, 65000, 30000, 5, 3), runs: 2, current: undefined, last: T(50000, 35000, 10000, 2, 1), waiting: false });
	h.emit("agent_settled", { aborted: false });
	assert.equal(h.appended.length, 1, "duplicate settle is ignored");
	h.emit("agent_start");
	h.now.t += 1000;
	h.emit("agent_settled", { aborted: true });
	assert.deepEqual(h.appended.at(-1), { v: 1, activeMs: 1000, ...zeroRun, aborted: true });
	assert.deepEqual(sumEntries(h.manager.getEntries()), { ...T(111000, 65000, 30000, 5, 3), runs: 3, last: T(1000) });
}));

test("shutdown persists a partial run, clears timer and summary; fresh session hides status", () => withFakeIntervals((live) => {
	const h = harness();
	h.emit("session_start");
	assert.equal(h.last(), undefined, "no status before the first run");
	h.emit("agent_start");
	h.now.t += 2500;
	h.emit("session_shutdown");
	assert.equal(live.size, 0);
	assert.deepEqual(h.appended, [{ v: 1, activeMs: 2500, ...zeroRun, partial: true }]);
	assert.equal(h.manager[SUMMARY], undefined);
	h.emit("session_shutdown");
	h.emit("agent_settled", { aborted: false });
	assert.equal(h.appended.length, 1);
}));

test("non-TUI modes persist without status or ticker", () => withFakeIntervals((live) => {
	const h = harness({ mode: "rpc" });
	h.emit("session_start");
	h.emit("agent_start");
	assert.equal(live.size, 0);
	h.now.t += 1000;
	h.emit("agent_settled", { aborted: false });
	assert.deepEqual(h.appended, [{ v: 1, activeMs: 1000, ...zeroRun }]);
	assert.deepEqual(h.statuses, []);
}));

test("statusText formats idle and running states", () => {
	assert.equal(statusText({ total: T(), runs: 0, waiting: false }), undefined);
	assert.equal(statusText({ total: T(), runs: 0, current: T(), waiting: false }), "⏱ 0s · ▶ running 0s");
	assert.equal(statusText({ total: T(3733000, 2400000, 1200000), runs: 4, waiting: false }), "⏱ 1h 02m");
	assert.equal(statusText({ total: T(3733000, 2400000, 1200000), runs: 4, last: T(325000, 200000, 100000), waiting: false }), "⏱ 1h 02m · ■ ran 5m 25s");
	assert.equal(statusText({ total: T(), runs: 1, current: T(1000), last: T(325000), waiting: false }), "⏱ 0s · ▶ running 1s", "current run replaces ran");
	const paint = (color, text) => `<${color}>${text}</>`;
	assert.equal(statusText({ total: T(1000, 500, 200), runs: 1, current: T(1000, 500, 200), waiting: true }, paint),
		"<dim>⏱ 1s</><warning> · ⏸ waiting 1s</>");
	assert.equal(statusText({ total: T(1000), runs: 1, last: T(1000), waiting: false }, paint),
		"<dim>⏱ 1s</><dim> · ■ ran 1s</>");
});

test("insertTime places the block before Tokens and falls back to appending", () => {
	const base = "Session Info\n\nMessages\nTotal: 3\n\nTokens\nInput: 1";
	assert.equal(insertTime(base, { total: T(61000, 40000, 20000, 1, 1), runs: 1, waiting: false }),
		"Session Info\n\nMessages\nTotal: 3\n\nTime\nAgent working: 1m 01s (1 run)\n  API inference: 40s (1 request)\n  Tools: 20s (1 call)\n  Other: 1s\n\nTokens\nInput: 1");
	assert.equal(insertTime("Odd", { total: T(), runs: 0, current: T(2000), waiting: true }),
		"Odd\n\nTime\nAgent working: 0s (0 runs)\n  API inference: 0s (0 requests)\n  Tools: 0s (0 calls)\n  Other: 0s\nCurrent run: 2s (waiting)\n  API inference: 0s (0 requests)\n  Tools: 0s (0 calls)\n  Other: 2s");
	assert.match(insertTime("Odd", { total: T(), runs: 1, last: T(325000), waiting: false }), /Other: 0s\nLast run: 5m 25s\n  API inference: 0s \(0 requests\)\n  Tools: 0s \(0 calls\)\n  Other: 5m 25s$/);
	assert.match(insertTime("Odd", { total: T(), runs: 1, current: T(1000), last: T(325000), waiting: false }), /Current run: 1s\n(  .*\n){2}  Other: 1s$/);
});

const usage = (cost) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
function sessionHost(summary) {
	const manager = SessionManager.inMemory("/workspace");
	manager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: usage(1), timestamp: Date.now() });
	if (summary) manager[SUMMARY] = () => summary;
	manager[Symbol.for("pi.subagent-cost.summary")] = () => ({ costUSD: 2, count: 1 });
	const stats = { sessionFile: "/s", sessionId: "test", totalMessages: 1, userMessages: 0, assistantMessages: 1,
		toolCalls: 0, toolResults: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 1 };
	const session = {
		sessionManager: manager, state: { model: { id: "test", provider: "test" } },
		settingsManager: { getCacheWarmingMode: () => "off" }, model: { id: "test", provider: "test" },
		getSessionStats: () => stats, modelRuntime: { getModel: () => undefined, isUsingSubscription: () => false },
	};
	const app = Object.create(InteractiveMode.prototype);
	Object.assign(app, { chatContainer: new Container(), ui: { requestRender() {} }, runtimeHost: { session } });
	return app;
}

test("real /session shows a styled Time section alongside RMB and subagent costs", () => {
	const app = sessionHost({ total: T(3733000, 2400000, 1200000, 52, 88), runs: 14, current: T(42000, 30000, 10000, 3, 2), waiting: false });
	app.chatContainer.addChild(new Text("Tokens", 0, 0)); // Earlier chat is untouched.
	app.handleSessionCommand();
	const out = textOf(app.chatContainer);
	assert.match(out, /Tools: 0 calls, 0 results\n\n Time\n Agent working: 1h 02m \(14 runs\)\n   API inference: 40m 00s \(52 requests\)\n   Tools: 20m 00s \(88 calls\)\n   Other: 2m 13s\n Current run: 42s\n   API inference: 30s \(3 requests\)\n   Tools: 10s \(2 calls\)\n   Other: 2s\n\n Tokens/);
	assert.equal((out.match(/Time\n/g) ?? []).length, 1);
	assert.equal(out.split("\n")[0], "Tokens");
	assert.match(out, /Parent: ¥6.70\n Subagents: ¥13.40\n Total: ¥20.10/);
	const raw = app.chatContainer.render(160).map((line) => line.trimEnd());
	const styleOf = (label) => raw.find((line) => plain(line).trim().startsWith(label)).replace(/^ /, "").split(label)[0];
	assert.equal(styleOf("Time"), styleOf("Tokens"), "header reuses Pi's header style");
	assert.equal(styleOf("Agent working:"), styleOf("Total:"), "labels reuse Pi's label style");
	assert.ok(styleOf("Total:").includes("\x1b["), "labels are styled");
	const none = sessionHost(undefined);
	none.handleSessionCommand();
	assert.doesNotMatch(textOf(none.chatContainer), /Agent working/);
});

test("reload does not stack wrappers in either load order", async () => {
	const before = [FooterComponent.prototype.render, FooterComponent.prototype.getSessionStats, InteractiveMode.prototype.handleSessionCommand];
	for (let i = 0; i < 3; i++) await loadAll();
	assert.deepEqual([FooterComponent.prototype.render, FooterComponent.prototype.getSessionStats, InteractiveMode.prototype.handleSessionCommand], before);
	const app = sessionHost({ total: T(1000), runs: 1, waiting: false });
	app.handleSessionCommand();
	const out = textOf(app.chatContainer);
	assert.equal((out.match(/Agent working/g) ?? []).length, 1);
	assert.equal((out.match(/Subagents:/g) ?? []).length, 1);
	assert.match(out, /Total: ¥20.10/);
});

test("rendered /session fits narrow widths across themes", () => {
	for (const theme of ["dark", "light"]) {
		setTheme(theme, false);
		for (const width of [12, 30, 80]) {
			const app = sessionHost({ total: T(3733000, 2400000, 1200000, 52, 88), runs: 14, current: T(42000), waiting: true });
			app.handleSessionCommand();
			for (const line of app.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
			assert.match(textOf(app.chatContainer, 80), /Current run: 42s \(waiting\)/);
		}
	}
});

test("Pi's real extension loader accepts the factory on reload", async () => {
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", sdk));
	const path = new URL("../index.ts", import.meta.url).pathname;
	const before = InteractiveMode.prototype.handleSessionCommand;
	for (let i = 0; i < 2; i++) {
		const loaded = await loadExtensions([path], process.cwd());
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		loaded.runtime.invalidate();
	}
	assert.equal(InteractiveMode.prototype.handleSessionCommand, before);
});

test("real agent loop: provider requests and parallel tools are split by wall time", async (t) => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import(new URL("../../pi-ai/dist/index.js", sdk));
	const dir = mkdtempSync(join(tmpdir(), "session-time-e2e-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const faux = createFauxCore({ provider: "faux", models: [{ id: "m" }] });
	// Real providers call onPayload (before_provider_request) before sending; faux does not.
	const reply = (message) => async (_context, options) => { await options?.onPayload?.({}, faux.getModel()); await sleep(100); return message; };
	faux.setResponses([
		reply(fauxAssistantMessage([fauxToolCall("wait", {}, { id: "t1" }), fauxToolCall("wait", {}, { id: "t2" })], { stopReason: "toolUse" })),
		reply(fauxAssistantMessage("done")),
	]);
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	modelRuntime.streamSimple = (model, context, options) => faux.streamSimple(model, context, options);
	modelRuntime.hasConfiguredAuth = () => true;
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname] });
	await resourceLoader.reload();
	const wait = { name: "wait", label: "wait", description: "wait", parameters: { type: "object", properties: {} },
		execute: async () => { await sleep(150); return { content: [{ type: "text", text: "ok" }], details: {} }; } };
	const sessionManager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), settingsManager,
		resourceLoader, sessionManager, customTools: [wait], tools: ["wait"] });
	t.after(() => session.dispose());
	await session.bindExtensions({}); // Emits session_start.
	await session.prompt("go");
	await sleep(20);
	const records = sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE).map((e) => e.data);
	assert.equal(records.length, 1);
	const [run] = records;
	assert.equal(run.requests, 2);
	assert.equal(run.toolCalls, 2);
	assert.ok(run.apiMs >= 190 && run.apiMs < 350, `apiMs ${run.apiMs}`);
	assert.ok(run.toolMs >= 140 && run.toolMs < 290, `toolMs ${run.toolMs}: parallel calls overlap`);
	assert.ok(run.activeMs >= run.apiMs + run.toolMs, `activeMs ${run.activeMs}`);
});
