import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { convertFooter, convertNotice, convertSessionInfo, formatRmb } from "../format.ts";

// Use real renderers without constructing a terminal, session, provider or watcher.
initTheme("dark", false);
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { codemodeRenderers } = await import(new URL("extensions/codemode/renderer.js", sdk));
const { setTheme } = await import(new URL("modes/interactive/theme/theme.js", sdk));
const resolvers = [];
const api = { registerToolRenderer: (resolver) => resolvers.push(resolver) };
const unpatchedFooter = FooterComponent.prototype.render;
await extension(api);
const resolver = resolvers.at(-1);
const context = () => ({ lastComponent: undefined, state: {}, toolCallId: "rmb-test", showImages: false });
const textOf = (component, width = 160) => component.render(width).map((line) => plain(line).trimEnd()).join("\n");
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const styledTheme = { fg: (_color, text) => `\x1b[33m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
const usage = (total, fields = {}) => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...fields,
	cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function host() {
	const first = { type: "message", message: { role: "assistant", provider: "p", model: "a$0.123", timestamp: 0, usage: usage(0.1, { cacheRead: 30000 }) } };
	const second = { type: "message", message: { role: "assistant", provider: "p", model: "b", timestamp: 360000, usage: usage(0.3, { input: 30000 }) } };
	const entries = [first, second];
	const stats = { sessionFile: "/work/$1.000/session", sessionId: "test", totalMessages: 2, userMessages: 0,
		assistantMessages: 2, toolCalls: 0, toolResults: 0, tokens: { input: 30000, output: 0, cacheRead: 30000, cacheWrite: 0, total: 60000 }, cost: 0.4 };
	const app = Object.create(InteractiveMode.prototype);
	Object.assign(app, {
		chatContainer: new Container(), ui: { requestRender() {} },
		runtimeHost: { session: {
			settingsManager: { getShowCacheMissNotices: () => true, getCacheWarmingMode: () => "auto" },
			sessionManager: { getSessionName: () => "费用 $2.000", getEntries: () => entries },
			getSessionStats: () => stats, model: { provider: "p", id: "b" }, modelRuntime: { getModel: () => undefined },
			cacheWarmingStatus: { state: "refreshing", decision: { economicsAvailable: true, phase: "idle", continuationProbability: 0.5,
				expectedSavings: -0.123, action: "warm", missCost: 0.3, warmCost: 0.02 } },
		} },
	});
	return { app, entries, stats };
}

function footer(cost, subscription = false) {
	const session = {
		state: { model: { id: "model$8.000", provider: "test" } },
		sessionManager: { getCwd: () => "/work/$5.000", getSessionName: () => "名字 $4.000" },
		modelRuntime: { isUsingSubscription: () => subscription },
	};
	const component = new FooterComponent(session, {
		getGitBranch: () => undefined, getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map([["test", "Budget $3.000"]]),
	});
	component.getSessionStats = () => ({ usageTotals: { input: 1200, output: 200, cacheRead: 0, cacheWrite: 0, cost },
		contextUsage: { contextWindow: 200000, percent: 10 }, latestCacheHitRate: undefined });
	return component;
}

test("currency formatting includes scientific notation and tiny charges without rounding them to zero", () => {
	assert.equal(formatRmb(1), "¥6.70");
	assert.equal(formatRmb(0), "¥0.00");
	assert.equal(formatRmb(-0.123), "-¥0.82");
	assert.equal(formatRmb(1e-7), "¥6.7e-7");
});

test("session conversion preserves names, paths, model IDs and unpriced reasons", () => {
	const original = "Session Info\nName: $1.000\nFile: /$2.000\n\nCache Warming\nStatus: Inactive (expected savings $3.000)\n\nCost\nTotal: $1.000\n  p/model$4.000: $0.100 (1k tokens)";
	const costs = { total: 1, models: new Map([["p/model$4.000", 0.1]]), missed: 0 };
	const converted = convertSessionInfo(original, costs);
	assert.match(converted, /Name: \$1.000/);
	assert.match(converted, /File: \/\$2.000/);
	assert.match(converted, /Inactive \(expected savings \$3.000\)/);
	assert.match(converted, /Total: ¥6.70/);
	assert.match(converted, /p\/model\$4.000: ¥0.67/);
	assert.equal(convertSessionInfo(converted, costs), converted);
});

test("actual /session renderer converts every priced field without modifying accounting or existing chat", () => {
	const { app, entries, stats } = host();
	const snapshot = JSON.stringify({ entries, stats, warming: app.session.cacheWarmingStatus });
	app.chatContainer.addChild(new Text("User says $7.000", 0, 0));
	app.handleSessionCommand();
	const rendered = textOf(app.chatContainer);
	for (const expected of ["Total: ¥2.68", "p/a$0.123: ¥0.67", "p/b: ¥2.01", "Cache Re-billed: ¥2.01",
		"expected savings -¥0.82 >= ¥", "Cache miss penalty: ¥2.01", "Refresh cost: ¥0.13"]) {
		assert.ok(rendered.includes(expected), expected);
	}
	assert.match(rendered, /User says \$7.000/);
	assert.match(rendered, /费用 \$2.000/);
	assert.match(rendered, /\/work\/\$1.000\/session/);
	assert.equal(JSON.stringify({ entries, stats, warming: app.session.cacheWarmingStatus }), snapshot);
	for (const theme of ["light", "dark"]) {
		setTheme(theme, false);
		app.chatContainer.invalidate();
		assert.equal(textOf(app.chatContainer), rendered);
	}
	for (const width of [12, 30, 80]) {
		for (const line of app.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("actual transcript notices convert only their charge suffix and keep upstream visibility thresholds", () => {
	const { app } = host();
	const warmed = { note: "budget $9.000", usage: usage(0.000123) };
	app.addCacheWarmingUsage(warmed);
	app.addCompactionCostNotice({ kind: "compaction", usage: usage(0.1, { input: 30000 }) });
	app.addCompactionCostNotice({ kind: "branch_summary", usage: usage(0.2, { input: 40000 }) });
	app.addCompactionCostNotice({ kind: "compaction", usage: usage(0.001, { input: 1000 }) });
	app.addCacheMissNotice({ missedTokens: 30000, missedCost: 0.3, modelChanged: false, idleMs: 600000 });
	const rendered = textOf(app.chatContainer);
	assert.match(rendered, /Cache warmed \(budget \$9.000\): ¥0.00082/);
	assert.match(rendered, /Compaction: 30k tokens billed \(~¥0.67\)/);
	assert.match(rendered, /Branch summary: 40k tokens billed \(~¥1.34\)/);
	assert.match(rendered, /Compaction: 1.0k tokens billed\n/);
	assert.match(rendered, /Cache miss after 10m idle: 30k tokens re-billed \(~¥2.01\)/);
	assert.equal(warmed.usage.cost.total, 0.000123);
	assert.equal(convertNotice("Cache warmed (price $1.000): $0.010", 0.0097), "Cache warmed (price $1.000): ¥0.06");
	const count = app.chatContainer.children.length;
	app.settingsManager.getShowCacheMissNotices = () => false;
	app.addCacheWarmingUsage(warmed);
	app.addCompactionCostNotice({ kind: "compaction", usage: usage(1) });
	app.maybeShowCacheMissNotice({});
	assert.equal(app.chatContainer.children.length, count);
});

test("footer preserves unrelated dollar text, fits widths and aligns the model", () => {
	for (const width of [12, 30, 60, 80, 160]) {
		const component = footer(1234.567);
		const lines = component.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
		assert.doesNotMatch(plain(lines[1]), /^(?:[↑↓RW]\S+ |CH\S+ )*\$/, "even truncated costs must use ¥");
		if (width >= 60) {
			assert.match(plain(lines[1]), /¥8271.60/);
			assert.match(plain(lines[1]), /model\$8.000$/);
			assert.equal(visibleWidth(lines[1]), width);
			assert.match(plain(lines[0]), /\$5.000/);
			assert.match(plain(lines[2]), /Budget \$3.000/);
		}
	}
	assert.match(plain(footer(0, true).render(80)[1]), /¥0.00 \(sub\)/);
	assert.doesNotMatch(plain(footer(0).render(80)[1]), /¥/);
	assert.equal(convertFooter("model$1.000"), "model$1.000");
});

test("reload does not stack prototype wrappers and always reinstalls renderer middleware", async () => {
	const before = [FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand, InteractiveMode.prototype.addCacheWarmingUsage];
	await extension(api);
	assert.deepEqual([FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand, InteractiveMode.prototype.addCacheWarmingUsage], before);
	assert.equal(resolvers.length, 2);
	assert.match(plain(footer(1).render(80)[1]), /¥6.70/);
	assert.equal(resolver("other", () => codemodeRenderers), codemodeRenderers);
	assert.equal(resolver("codemode", () => undefined), undefined);
});

test("codemode delegates rendering while converting per-call and total costs, not args/errors/output", () => {
	const renderers = resolver("codemode", () => codemodeRenderers);
	const calls = [
		{ name: "model", args: "Model calls: $0.10", status: "ok", cost: 0.000001, durationMs: 20 },
		{ name: "model", args: "$0.50", status: "error", cost: 0.1, error: "failed with $0.99" },
	];
	const result = { details: { calls }, content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text", text: "Output budget $3.14\nModel calls: $9.99" }] };
	const snapshot = JSON.stringify(result);
	for (const theme of [plainTheme, styledTheme]) {
		for (const expanded of [false, true]) {
			const ctx = context();
			const component = renderers.renderResult(result, { expanded, isPartial: false }, theme, ctx);
			const rendered = textOf(component);
			assert.match(rendered, /Model calls: \$0.10/);
			assert.match(rendered, /\$0.50/);
			assert.match(rendered, /¥0.0000067/);
			assert.match(rendered, /¥0.67/);
			assert.match(rendered, /Model calls: ¥0.67/);
			assert.match(rendered, /Output budget \$3.14/);
			assert.match(rendered, /Model calls: \$9.99/);
			if (expanded) assert.match(rendered, /failed with \$0.99/);
			ctx.lastComponent = component;
			assert.equal(renderers.renderResult(result, { expanded, isPartial: false }, theme, ctx), component);
			for (const width of [12, 30, 80]) {
				for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
			}
		}
	}
	assert.equal(JSON.stringify(result), snapshot);
	assert.equal(renderers.renderCall, codemodeRenderers.renderCall);
});

test("codemode handles partial updates, collapsed earlier calls and unpriced calls", () => {
	const renderers = resolver("codemode", () => codemodeRenderers);
	const calls = Array.from({ length: 10 }, (_, i) => ({ name: "model", args: i === 9 ? "Model calls: $0.90" : "", status: "running", cost: i === 9 ? undefined : 0.1 }));
	const result = { details: { calls }, content: [{ type: "text", text: "Output $4.00" }] };
	const rendered = textOf(renderers.renderResult(result, { expanded: false, isPartial: true }, plainTheme, context()));
	assert.match(rendered, /2 earlier calls/);
	assert.match(rendered, /Model calls: \$0.90/);
	assert.match(rendered, /Model calls: ¥6.03/);
	assert.doesNotMatch(rendered, /Output/);
	const empty = { content: [{ type: "text", text: "Output $4.00" }] };
	assert.equal(textOf(renderers.renderResult(empty, { expanded: true, isPartial: false }, plainTheme, context())), "\nOutput $4.00");
});

test("all cost displays convert raw amounts before USD rounding", () => {
	assert.match(plain(footer(0.0149).render(80)[1]), /¥0.10/);
	assert.match(plain(footer(0.0001499).render(80)[1]), /¥0.0010/);
	const { app, entries, stats } = host();
	for (const entry of entries) Object.assign(entry.message.usage.cost, { input: 0.0149, total: 0.0149 });
	stats.cost = 0.0298;
	Object.assign(app.session.cacheWarmingStatus.decision, { expectedSavings: 0.0149, missCost: 0.0149, warmCost: 0.0149 });
	app.handleSessionCommand();
	app.addCompactionCostNotice({ kind: "compaction", usage: usage(0.0149) });
	app.addCacheWarmingUsage({ usage: usage(0.000001499) });
	const rendered = textOf(app.chatContainer);
	for (const text of ["Total: ¥0.20", "p/a$0.123: ¥0.10", "p/b: ¥0.10", "Cache Re-billed: ¥0.10",
		"expected savings ¥0.10", "Cache miss penalty: ¥0.10", "Refresh cost: ¥0.10", "(~¥0.10)", "Cache warmed: ¥0.000010"]) {
		assert.ok(rendered.includes(text), text);
	}
	const result = { details: { calls: [{ name: "model", args: "", status: "ok", cost: 0.0149 }, { name: "model", args: "", status: "ok", cost: 0.0149 }] }, content: [] };
	const codemode = textOf(resolver("codemode", () => codemodeRenderers).renderResult(result, { expanded: true, isPartial: false }, plainTheme, context()));
	assert.equal((codemode.match(/¥0.10/g) ?? []).length, 2);
	assert.match(codemode, /Model calls: ¥0.20/);
});

test("a legacy footer requires restart instead of stacking or double-converting", async (t) => {
	const patched = FooterComponent.prototype.render;
	const legacySymbol = Symbol.for("pi.rmb-cost.patched");
	const legacy = function (width) {
		const lines = unpatchedFooter.call(this, width);
		lines[1] = lines[1].replace(/\$(\d+\.\d{3})/g, (_match, amount) => `¥${(Number(amount) * 6.7).toFixed(2)}`);
		return lines;
	};
	FooterComponent.prototype.render = legacy;
	FooterComponent.prototype[legacySymbol] = true;
	t.after(() => { FooterComponent.prototype.render = patched; delete FooterComponent.prototype[legacySymbol]; });
	let onStart;
	await extension({ registerToolRenderer() {}, on: (_event, handler) => { onStart = handler; } });
	assert.equal(FooterComponent.prototype.render, legacy);
	assert.match(plain(footer(1).render(80)[1]), /¥6.70/);
	const notices = [];
	onStart({}, { hasUI: true, ui: { notify: (message) => notices.push(message) } });
	assert.equal(notices.length, 1);
	assert.match(notices[0], /restart Pi once/);
});

test("Pi's real extension loader accepts the async factory and reinstalls middleware", async () => {
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", sdk));
	const path = new URL("../index.ts", import.meta.url).pathname;
	const before = FooterComponent.prototype.render;
	for (let i = 0; i < 2; i++) {
		const loaded = await loadExtensions([path], process.cwd());
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.equal(loaded.extensions[0].toolRenderers.length, 1);
		loaded.runtime.invalidate();
	}
	assert.equal(FooterComponent.prototype.render, before);
});

test("reloading an edited rate refreshes all callbacks without stacking wrappers", async (t) => {
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", sdk));
	const dir = mkdtempSync(join(tmpdir(), "rmb-reload-"));
	t.after(async () => { await extension(api); rmSync(dir, { recursive: true, force: true }); });
	const before = [FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand, InteractiveMode.prototype.addCacheWarmingUsage];
	const source = readFileSync(new URL("../format.ts", import.meta.url), "utf8");
	let reloaded;
	for (const rate of [6.7, 7]) {
		const path = join(dir, String(rate));
		mkdirSync(path);
		copyFileSync(new URL("../index.ts", import.meta.url), join(path, "index.ts"));
		writeFileSync(join(path, "format.ts"), source.replace("USD_TO_RMB = 6.7", `USD_TO_RMB = ${rate}`));
		const loaded = await loadExtensions([join(path, "index.ts")], path);
		assert.deepEqual(loaded.errors, []);
		reloaded = loaded.extensions[0].toolRenderers[0];
		loaded.runtime.invalidate();
	}
	assert.deepEqual([FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand, InteractiveMode.prototype.addCacheWarmingUsage], before);
	assert.match(plain(footer(1).render(80)[1]), /¥7.00/);
	const { app } = host();
	app.handleSessionCommand();
	app.addCacheWarmingUsage({ usage: usage(1) });
	app.addCompactionCostNotice({ kind: "compaction", usage: usage(1) });
	app.addCacheMissNotice({ missedTokens: 30000, missedCost: 1 });
	const rendered = textOf(app.chatContainer);
	assert.match(rendered, /Total: ¥2.80/);
	assert.match(rendered, /Cache warmed: ¥7.00/);
	assert.equal((rendered.match(/\(~¥7.00\)/g) ?? []).length, 2);
	const result = { details: { calls: [{ name: "model", args: "", status: "ok", cost: 1 }] }, content: [] };
	assert.match(textOf(reloaded("codemode", () => codemodeRenderers).renderResult(result, { expanded: true, isPartial: false }, plainTheme, context())), /¥7.00/);
});
