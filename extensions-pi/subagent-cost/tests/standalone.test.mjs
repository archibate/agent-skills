import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent, InteractiveMode, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { installPresentation, SUMMARY } from "../presentation.ts";

initTheme("dark", false);
installPresentation();

test("standalone native USD footer and /session need no RMB extension", () => {
	const manager = SessionManager.inMemory();
	manager.appendUsage("test", "test", "test", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } });
	manager[SUMMARY] = () => ({ costUSD: 2, count: 1 });
	const session = {
		sessionManager: manager, state: { model: { id: "test", provider: "test" } }, model: { id: "test", provider: "test" },
		modelRuntime: { isUsingSubscription: () => false, getModel: () => undefined },
		getContextUsage: () => undefined,
		settingsManager: { getCacheWarmingMode: () => "off" },
		getSessionStats: () => ({ cost: 1, sessionId: "test", totalMessages: 0, userMessages: 0, assistantMessages: 0,
			toolCalls: 0, toolResults: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
	};
	const footer = new FooterComponent(session, { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() });
	assert.match(plain(footer.render(80)[1]), /\$3.000/);
	const app = Object.create(InteractiveMode.prototype);
	Object.assign(app, { chatContainer: new Container(), ui: { requestRender() {} }, runtimeHost: { session } });
	app.handleSessionCommand();
	const text = app.chatContainer.render(80).map((line) => plain(line).trim()).join("\n");
	assert.match(text, /Parent: \$1.000\nSubagents: \$2.000\nTotal: \$3.000/);
	assert.doesNotMatch(text, /¥/);
});
