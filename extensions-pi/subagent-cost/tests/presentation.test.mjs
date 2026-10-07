import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent, InteractiveMode, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import rmb from "../../rmb-cost/index.ts";
import { SUMMARY } from "../presentation.ts";

initTheme("dark", false);
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { setTheme } = await import(new URL("modes/interactive/theme/theme.js", sdk));
const api = { on() {}, registerToolRenderer() {} };
const rmbFirst = process.env.COST_LOAD_ORDER === "rmb-first";
async function load() {
	if (rmbFirst) { await rmb(api); extension(api); }
	else { extension(api); await rmb(api); }
}
await load();
const usage = (cost) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const textOf = (component, width = 160) => component.render(width).map((line) => plain(line).trimEnd()).join("\n");
function host(parent = 1, child = 2, count = 1) {
	const manager = SessionManager.inMemory("/workspace");
	manager.appendMessage({ role: "assistant", content: [], provider: "test", model: "test", usage: usage(parent), timestamp: Date.now() });
	let children = { costUSD: child, count };
	let reconciliations = 0;
	manager[SUMMARY] = (refresh) => { if (refresh) reconciliations++; return { ...children }; };
	const stats = { sessionFile: "/work/$1.000/session", sessionId: "test", totalMessages: 1, userMessages: 0,
		assistantMessages: 1, toolCalls: 0, toolResults: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: parent };
	const session = {
		sessionManager: manager, state: { model: { id: "test", provider: "test" } },
		settingsManager: { getCacheWarmingMode: () => "off" },
		model: { id: "test", provider: "test" },
		getSessionStats: () => stats, modelRuntime: { getModel: () => undefined, isUsingSubscription: () => false },
		getContextUsage: () => ({ contextWindow: 100000, percent: 1 }),
	};
	const footer = new FooterComponent(session, { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() });
	const app = Object.create(InteractiveMode.prototype);
	Object.assign(app, { chatContainer: new Container(), ui: { requestRender() {} }, runtimeHost: { session } });
	return { footer, app, stats, manager, update: (cost) => { children = { costUSD: cost, count }; }, reconciliations: () => reconciliations };
}

test("real footer and /session show family cost once in RMB, parent token stats unchanged", () => {
	const h = host(0.0149, 0.0149);
	assert.match(plain(h.footer.render(100)[1]), /¥0.20/);
	h.app.chatContainer.addChild(new Text("User budget $9.000", 0, 0));
	h.app.handleSessionCommand();
	const output = textOf(h.app.chatContainer);
	assert.match(output, /Parent: ¥0.10\n Subagents: ¥0.10\n Total: ¥0.20/);
	assert.match(output, /User budget \$9.000/);
	assert.equal(h.stats.cost, 0.0149);
	assert.equal(h.reconciliations(), 1);
	assert.equal(h.footer.getSessionStats().usageTotals.input, 10);
	h.update(1);
	assert.match(plain(h.footer.render(100)[1]), /¥6.80/);
	assert.equal(textOf(h.app.chatContainer), output, "previous /session messages are snapshots");
});

test("zero parent and children, no children and tiny charges", () => {
	const h = host(0, 0.000001);
	h.app.handleSessionCommand();
	assert.match(textOf(h.app.chatContainer), /Parent: ¥0.00\n Subagents: ¥0.0000067\n Total: ¥0.0000067/);
	const zero = host(0, 0);
	zero.app.handleSessionCommand();
	assert.match(textOf(zero.app.chatContainer), /Subagents: ¥0.00/);
	const none = host(1, 0, 0);
	none.app.handleSessionCommand();
	assert.doesNotMatch(textOf(none.app.chatContainer), /Subagents:/);
});

test("reload does not stack either extension, both load orders", async () => {
	const before = [FooterComponent.prototype.getSessionStats, FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand];
	for (let i = 0; i < 3; i++) await load();
	assert.deepEqual([FooterComponent.prototype.getSessionStats, FooterComponent.prototype.render, InteractiveMode.prototype.handleSessionCommand], before);
	const h = host();
	h.app.handleSessionCommand();
	assert.equal((textOf(h.app.chatContainer).match(/Subagents:/g) ?? []).length, 1);
	assert.match(textOf(h.app.chatContainer), /Total: ¥20.10/);
	assert.match(plain(h.footer.render(100)[1]), /¥20.10/);
});

test("real rendered output fits narrow widths and rebuilds across themes", () => {
	const output = [];
	for (const theme of ["dark", "light"]) {
		setTheme(theme, false);
		for (const width of [12, 30, 80, 160]) {
			const h = host();
			h.app.handleSessionCommand();
			for (const line of [...h.footer.render(width), ...h.app.chatContainer.render(width)]) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
			}
			output.push(`${theme} width=${width}\n${textOf(h.footer, width)}\n${textOf(h.app.chatContainer, width)}`);
		}
	}
	writeFileSync(join(process.env.PI_SCRATCHPAD_DIR, `subagent-cost-render-${rmbFirst ? "rmb-first" : "cost-first"}.txt`), output.join("\n\n"));
});

test("real Pi extension loader accepts the factory on reload without starting watchers", async () => {
	const { loadExtensions } = await import(new URL("core/extensions/loader.js", sdk));
	const path = new URL("../index.ts", import.meta.url).pathname;
	const before = FooterComponent.prototype.getSessionStats;
	for (let i = 0; i < 2; i++) {
		const loaded = await loadExtensions([path], process.cwd());
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		loaded.runtime.invalidate();
	}
	assert.equal(FooterComponent.prototype.getSessionStats, before);
});
