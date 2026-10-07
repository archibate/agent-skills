import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const sdk = await import(`${f.host}/dist/index.js`);
const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
const { default: register } = await f.load("index.ts");
const usage = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=" };
const text = (text) => ({ type: "text", text });
const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const collectText = (content) => content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

async function sessionFixture({ runtime, model, extensions = [], customTools = [], pairings, flags = {}, settings = {}, options = {} }) {
	const root = mkdtempSync(join(f.scratch, "session-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	if (pairings !== undefined) writeFileSync(join(agentDir, "advisor.json"), JSON.stringify({ pairings }));
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...settings });
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => register(pi, agentDir), ...extensions], systemPromptOverride: () => "You are a test executor. Follow the user's task. Only use the provided tools.",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	for (const [key, value] of Object.entries(flags)) loader.getExtensions().runtime.flagValues.set(key, value);
	const { session } = await sdk.createAgentSession({
		cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "low", resourceLoader: loader,
		settingsManager, sessionManager: sdk.SessionManager.inMemory(cwd), noTools: "builtin", customTools, ...options,
	});
	return { session, loader, agentDir };
}

test("Pi's file loader accepts the multi-file extension without starting requests", async () => {
	const { loadExtensions } = await import(`${f.host}/dist/core/extensions/loader.js`);
	const loaded = await loadExtensions([join(f.scratch, "extension/index.ts")], f.scratch);
	try {
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.ok(loaded.extensions[0].tools.has("advisor"));
	} finally { loaded.runtime.invalidate(); }
});

test("real Pi loop gathers evidence, consults twice, persists usage, and exposes only a text-only advisor result", async () => {
	const advisorContexts = [];
	let turns = 0;
	const model = { type: "chat", id: "main", name: "Fixture", provider: "advisor-fixture", api: "openai-completions", baseUrl: "https://invalid.test", input: ["text", "image"], reasoning: true, contextWindow: 200_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const advisorModel = { ...model, id: "reviewer" };
	const reply = (selected, context) => {
		const stream = ai.createAssistantMessageEventStream();
		let content;
		if (selected.id === "reviewer") {
			advisorContexts.push(structuredClone(context));
			assert.equal(context.tools?.length ?? 0, 0);
			assert.deepEqual(context.messages.map((m) => m.role), ["system", "user"]);
			content = [{ type: "thinking", thinking: "PRIVATE REVIEWER THOUGHTS" }, text(`Review ${advisorContexts.length}: verify the fixture result.`)];
		} else {
			assert.ok(++turns <= 5, "Unexpected main-model loop");
			content = turns === 1 ? [call("read1", "read_fixture")]
				: turns === 2 ? [call("consult1", "advisor")]
				: turns === 3 ? [call("read2", "read_fixture")]
				: turns === 4 ? [call("consult2", "advisor")]
				: [text("Done.")];
		}
		const message = { role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id, stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", usage, timestamp: Date.now() };
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end();
		return stream;
	};
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(ai.createProvider({ id: model.provider, name: "Fixture", models: [model, advisorModel], auth: { apiKey: ai.envApiKeyAuth("Fixture key", []) }, api: { "openai-completions": { stream: reply, streamSimple: reply } } }));
	let reads = 0;
	const { session, loader } = await sessionFixture({ runtime, model, customTools: [{
		name: "read_fixture", label: "Fixture", description: "Read synthetic evidence.", parameters: ai.Type.Object({}),
		execute: async () => ({ content: [text(`Evidence ${++reads}`), image], details: undefined }),
	}] });
	const errors = [];
	try {
		loader.getExtensions().runtime.flagValues.set("advisor", `${model.provider}/reviewer`);
		loader.getExtensions().runtime.flagValues.set("advisor-thinking", "low");
		await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
		await session.prompt("Inspect the fixture and review it twice.");
		assert.deepEqual(errors, []);
		assert.equal(turns, 5);
		assert.equal(advisorContexts.length, 2, JSON.stringify(session.messages.filter((m) => m.role === "toolResult" && m.isError)));
		const first = advisorContexts[0].messages.find((m) => m.role === "user").content;
		const second = advisorContexts[1].messages.find((m) => m.role === "user").content;
		assert.match(collectText(first), /Evidence 1/);
		assert.ok(first.some((b) => b.type === "image"));
		assert.deepEqual(second.slice(0, first.length), first, "Existing transcript blocks must remain identical");
		assert.match(collectText(second), /Prior advisor result[\s\S]*Review 1[\s\S]*Evidence 2/);
		assert.doesNotMatch(collectText(second), /PRIVATE REVIEWER/);
		const reviews = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "advisor");
		assert.equal(reviews.length, 2);
		assert.ok(reviews.every((r) => !r.isError && r.usage.input === 11 && r.details.model.endsWith("/reviewer")));
		assert.equal(session.getLastAssistantText(), "Done.");
		assert.equal(session.getSessionStats().tokens.total, 7 * usage.totalTokens, "Nested advisor usage must be counted exactly once");
	} finally { session.dispose(); }
});

async function selectionRuntime() {
	const models = ["cheap", "frontier", "reviewer"].map((id) => ({ type: "chat", id, name: id, provider: "pairing-fixture", api: "openai-completions", baseUrl: "https://invalid.test", input: ["text"], reasoning: true, contextWindow: 200_000, maxTokens: 32_000, cost: usage.cost }));
	const requests = [];
	const reply = (model, context) => {
		requests.push({ model: model.id, tools: ai.getCurrentTools(context.messages).map((tool) => tool.name) });
		const stream = ai.createAssistantMessageEventStream();
		const message = { role: "assistant", content: [text("Done.")], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage, timestamp: Date.now() };
		stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
	};
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify(models[0].provider, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(ai.createProvider({ id: models[0].provider, name: "Fixture", models, auth: { apiKey: ai.envApiKeyAuth("Fixture key", []) }, api: { "openai-completions": { stream: reply, streamSimple: reply } } }));
	await runtime.refresh({ providers: [models[0].provider], allowNetwork: false });
	await runtime.getAvailable(); // Await the full availability pass queued by provider registration.
	assert.equal(runtime.getAvailableSnapshot().filter((m) => m.provider === models[0].provider).length, models.length);
	return { runtime, models, requests, pairings: { "pairing-fixture/cheap": "pairing-fixture/reviewer", "pairing-fixture/frontier": null } };
}

test("real SDK selection, scoped cycling, tree restoration, and reload reconcile exposure without changing other tools", async () => {
	const { runtime, models, requests, pairings } = await selectionRuntime();
	let api;
	const { session, agentDir } = await sessionFixture({ runtime, model: models[0], pairings, extensions: [(pi) => { api = pi; }],
		options: { tools: ["advisor", "keep", "manual-off"], scopedModels: models.slice(0, 2).map((model) => ({ model })) },
		customTools: ["keep", "manual-off"].map((name) => ({ name, label: name, description: name, parameters: ai.Type.Object({}), execute: async () => ({ content: [], details: undefined }) })),
	});
	const errors = [];
	try {
		await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e.error) });
		assert.deepEqual(session.getActiveToolNames().sort(), ["advisor", "keep", "manual-off"]);
		session.setActiveToolsByName(["advisor", "keep"]);
		await session.prompt("paired");
		const oldLeaf = session.sessionManager.getLeafId();
		assert.deepEqual(requests.at(-1).tools.sort(), ["advisor", "keep"]);
		await session.setModel(models[1]);
		assert.deepEqual(session.getActiveToolNames(), ["keep"]);
		assert.equal(api.getAllTools().find((t) => t.name === "advisor").exposure, "hidden");
		await session.prompt("unpaired");
		assert.deepEqual(requests.at(-1).tools, ["keep"]);
		await session.navigateTree(oldLeaf, { summarize: false });
		assert.equal(session.model.id, "frontier", "Tree navigation keeps the selected model");
		assert.ok(!session.getActiveToolNames().includes("advisor"), "Historical loadout must not reenable advisor");
		const cycle = await session.cycleModel();
		assert.equal(cycle.model.id, "cheap");
		assert.ok(session.getActiveToolNames().includes("advisor"));
		writeFileSync(join(agentDir, "advisor.json"), '{"pairings":{}}');
		await session.reload();
		assert.ok(!session.getActiveToolNames().includes("advisor"));
		assert.deepEqual(errors, []);
	} finally { session.dispose(); }
});

test("startup defaults and resumed main models select pairings rather than persisting CLI overrides", async () => {
	const { runtime, models, pairings } = await selectionRuntime();
	const original = await sessionFixture({ runtime, pairings, flags: { advisor: "none" }, settings: { defaultProvider: models[0].provider, defaultModel: "cheap" } });
	let resumed;
	try {
		await original.session.bindExtensions({ mode: "print", onError: (e) => assert.fail(e.error) });
		assert.equal(original.session.model.id, "cheap");
		assert.ok(!original.session.getActiveToolNames().includes("advisor"));
		await original.session.prompt("Persist the selected main model.");
		resumed = await sessionFixture({ runtime, pairings, settings: { defaultProvider: models[0].provider, defaultModel: "frontier" }, options: { sessionManager: original.session.sessionManager } });
		await resumed.session.bindExtensions({ mode: "print", onError: (e) => assert.fail(e.error) });
		assert.equal(resumed.session.model.id, "cheap");
		assert.ok(resumed.session.getActiveToolNames().includes("advisor"));
	} finally { original.session.dispose(); resumed?.session.dispose(); }
});

test("explicit advisor overrides persist across model changes/reload, but Pi tool exclusion wins", async () => {
	for (const flags of [{ advisor: "pairing-fixture/reviewer" }, { advisor: "none" }]) {
		const { runtime, models, pairings } = await selectionRuntime();
		const { session } = await sessionFixture({ runtime, model: models[0], pairings, flags });
		try {
			await session.bindExtensions({ mode: "print", onError: (e) => assert.fail(e.error) });
			await session.setModel(models[1]);
			assert.equal(session.getActiveToolNames().includes("advisor"), flags.advisor !== "none");
			await session.reload();
			assert.equal(session.getActiveToolNames().includes("advisor"), flags.advisor !== "none");
		} finally { session.dispose(); }
	}
	const { runtime, models, requests, pairings } = await selectionRuntime();
	const { session } = await sessionFixture({ runtime, model: models[0], pairings, options: { noTools: "all" } });
	try {
		await session.bindExtensions({ mode: "print", onError: (e) => assert.fail(e.error) });
		await session.prompt("No tools.");
		assert.deepEqual(requests[0].tools, []);
	} finally { session.dispose(); }
});
