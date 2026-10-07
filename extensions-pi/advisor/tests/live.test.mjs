// Opt-in, bounded Ofox E2E. Sends only synthetic fixture data; never reads user sessions or auth.json.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "./host.mjs";

test("live Luna executor and advisor complete two consultations with native image evidence", { skip: process.env.PI_ADVISOR_LIVE !== "1", timeout: 120_000 }, async () => {
	assert.ok(process.env.OFOX_API_KEY, "OFOX_API_KEY is required");
	const f = fixture();
	let session;
	let timer;
	try {
		const sdk = await import(`${f.host}/dist/index.js`);
		const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
		const { default: advisor } = await f.load("index.ts");
		cpSync(fileURLToPath(new URL("../../ofox", import.meta.url)), join(f.scratch, "ofox"), { recursive: true });
		const { createOfoxProvider } = await import(join(f.scratch, "ofox/provider.ts"));
		const catalogPath = process.env.PI_ADVISOR_LIVE_CATALOG ?? join(homedir(), ".pi/agent/models-store.json");
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
		const original = catalog.ofox?.models?.find((m) => m.id === "openai/gpt-6-luna");
		assert.ok(original, "A cached Ofox openai/gpt-6-luna model is required; this test does not discover models");
		const model = { ...original, maxTokens: 2048 };
		const store = new ai.InMemoryModelsStore();
		await store.write("ofox", { models: [model], checkedAt: Date.now() });
		const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: store, modelsPath: null, refreshOnCreate: false });
		const provider = createOfoxProvider();
		const originalStream = provider.streamSimple;
		let requestCount = 0;
		const advisorInputs = [];
		provider.streamSimple = (selected, context, options) => {
			assert.ok(++requestCount <= 8, "Live request budget exceeded");
			assert.equal(selected.id, "openai/gpt-6-luna", "Only the explicitly approved cheap model may run");
			assert.ok(selected.maxTokens <= 2048);
			const review = ai.getCurrentTools(context.messages).length === 0;
			if (review) advisorInputs.push(structuredClone(context));
			assert.ok(advisorInputs.length <= 2, "Advisor invocation budget exceeded");
			return originalStream(selected, context, {
				...options, maxTokens: 2048, maxRetries: 0, timeoutMs: 45_000, transport: "sse",
				onPayload: async (payload, model) => {
					const replaced = await options?.onPayload?.(payload, model);
					const body = replaced ?? payload;
					assert.ok(body.max_output_tokens <= 2048, "Output cap missing on the wire");
					if (review) assert.equal(body.tools?.length ?? 0, 0, "Advisor must have no wire tools");
					return body;
				},
			});
		};
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ providers: ["ofox"], allowNetwork: false });
		const cwd = join(f.scratch, "workspace"); const agentDir = join(f.scratch, "agent");
		mkdirSync(cwd); mkdirSync(agentDir);
		const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } });
		const loader = new sdk.DefaultResourceLoader({
			cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => advisor(pi, agentDir)], systemPromptOverride: () => "You are a test executor. Follow the user's requested tool sequence. Keep your final response brief.",
		});
		await loader.reload();
		loader.getExtensions().runtime.flagValues.set("advisor", "ofox/openai/gpt-6-luna");
		loader.getExtensions().runtime.flagValues.set("advisor-thinking", "low");
		loader.getExtensions().runtime.flagValues.set("advisor-max-tokens", "2048");
		loader.getExtensions().runtime.flagValues.set("advisor-timeout", "45");
		session = (await sdk.createAgentSession({
			cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "low", resourceLoader: loader, settingsManager: settings,
			sessionManager: sdk.SessionManager.inMemory(cwd), noTools: "builtin",
			customTools: [{
				name: "read_fixture", label: "Fixture", description: "Read the synthetic fixture and its tiny image.", parameters: ai.Type.Object({}),
				execute: async () => ({ content: [
					{ type: "text", text: "Synthetic fixture: value=42; status=ready. The attached 16x16 image is only a transport fixture, not evidence requiring interpretation." },
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=" },
				], details: undefined }),
			}],
		})).session;
		const errors = [];
		await session.bindExtensions({ mode: "print", onError: (e) => errors.push(e.error) });
		timer = setTimeout(() => { void session.abort(); }, 100_000);
		await session.prompt("This is a plumbing test, not a test of advice quality. Call read_fixture once. After its result arrives, call advisor. After that advice arrives, call advisor once more so it can see the prior advice. Then finish in one sentence. Exactly two advisor calls, in separate turns; do not execute any additional work the advisor suggests.");
		assert.deepEqual(errors, []);
		const results = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "advisor");
		assert.equal(results.length, 2, JSON.stringify(session.messages.filter((m) => m.role === "assistant").map((m) => ({ stopReason: m.stopReason, error: m.errorMessage, text: m.content.filter((b) => b.type === "text") }))));
		for (const result of results) {
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.ok(result.usage.totalTokens > 0);
			assert.ok(result.content.every((b) => b.type === "text"));
		}
		assert.equal(advisorInputs.length, 2);
		const first = advisorInputs[0].messages.find((m) => m.role === "user").content;
		const second = advisorInputs[1].messages.find((m) => m.role === "user").content;
		assert.ok(first.some((b) => b.type === "image"));
		assert.deepEqual(second.slice(0, first.length), first);
		assert.match(second.filter((b) => b.type === "text").map((b) => b.text).join("\n"), /Prior advisor result/);
		const allUsage = session.messages.filter((m) => m.usage).map((m) => m.usage);
		console.log(JSON.stringify({ requests: requestCount, consultations: results.length, tokens: allUsage.reduce((n, u) => n + u.totalTokens, 0), estimatedUSD: allUsage.reduce((n, u) => n + u.cost.total, 0) }));
	} finally {
		clearTimeout(timer);
		session?.dispose();
		f.cleanup();
	}
});
