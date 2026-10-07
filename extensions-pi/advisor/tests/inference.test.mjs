import assert from "node:assert/strict";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const { prepareModel, validateAnthropicRequest } = await f.load("inference.ts");
const { TranscriptCache } = await f.load("cache.ts");
const { readConfig } = await f.load("config.ts");
const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
const { anthropicMessagesApi } = await import(`${f.host}/../pi-ai/dist/compat.js`);
const { getBuiltinModels } = await import(`${f.host}/../pi-ai/dist/providers/all.js`);
const models = getBuiltinModels("anthropic");
const config = readConfig(() => undefined, "anthropic/claude-opus-5-5");

async function capture(model, options = {}) {
	let payload;
	const provider = ai.createProvider({ id: "anthropic", name: "Fixture", auth: {}, models: [model], api: { "anthropic-messages": anthropicMessagesApi() } });
	await provider.streamSimple(model, ai.normalizeContext({ systemPrompt: "Reviewer", messages: [{ role: "user", content: [{ type: "text", text: "[User]\nTask" }], timestamp: 0 }] }), {
		apiKey: "unit-test-key", reasoning: "high", maxTokens: model.maxTokens,
		onPayload: (value) => { payload = value; throw new Error("Stop before HTTP"); }, ...options,
	}).result();
	assert.ok(payload, "Adapter should construct a payload without network access");
	return payload;
}

test("virtual routers are rejected before they can replace the physical-model safeguards", () => {
	const virtual = { ...models.find((m) => m.id === "claude-opus-5-5"), api: "pi-virtual" };
	assert.throws(() => prepareModel(virtual, config), /physical provider\/model/);
});

test("native Opus managed effort becomes static and works with one user message even with caching disabled", async () => {
	const original = models.find((m) => m.id === "claude-opus-5-5");
	assert.ok(original?.compat.supportsMidConvoEffort);
	const before = structuredClone(original);
	const model = prepareModel(original, config);
	const payload = await capture(model);
	assert.deepEqual(payload.messages.map((m) => m.role), ["user"]);
	assert.equal(payload.output_config.effort, "high");
	assert.equal(payload.thinking.type, "adaptive");
	assert.equal(payload.max_tokens, original.maxTokens);
	assert.equal(payload.tools, undefined);
	validateAnthropicRequest(payload, original.maxTokens);
	const cache = new TranscriptCache();
	cache.prepare(payload, "native", "short")();
	cache.prepare(payload, "native", "none")();
	assert.deepEqual(original, before);
});

test("default output follows model metadata, including limits beyond the optional flag's range", () => {
	const original = models.find((m) => m.id === "claude-opus-5-5");
	for (const maxTokens of [4096, 64000, 262144]) {
		const selected = { ...original, maxTokens };
		assert.equal(prepareModel(selected, config).maxTokens, maxTokens);
		assert.equal(selected.maxTokens, maxTokens);
	}
});

test("an explicit output cap still reaches the Anthropic wire", async () => {
	const model = prepareModel(models.find((m) => m.id === "claude-opus-5-5"), { ...config, maxTokens: 4096 });
	const payload = await capture(model);
	assert.equal(payload.max_tokens, 4096);
	validateAnthropicRequest(payload, 4096);
});

test("inherited Anthropic fallbacks are removed on the wire", async () => {
	const original = models.find((m) => m.id === "claude-fable-5");
	assert.ok(original?.compat.allowedFallbackModels?.length);
	const model = prepareModel(original, config);
	const payload = await capture(model);
	assert.equal(payload.fallbacks, undefined);
	assert.ok(!payload.betas?.some((beta) => /fallback/.test(beta)));
	assert.ok(original.compat.allowedFallbackModels.length, "Shared model metadata must not be mutated");
	assert.throws(() => validateAnthropicRequest({ max_tokens: 8192, fallbacks: [{}] }, 8192), /fallback/);
});

test("manual-thinking ceilings fail before HTTP when too small, while 2048 and adaptive 1024 are valid", async () => {
	const manual = models.find((m) => m.id.includes("haiku-4-5"));
	assert.ok(manual && !manual.compat?.forceAdaptiveThinking);
	for (const maxTokens of [1024, 1025, 1536, 2047]) {
		assert.throws(() => prepareModel(manual, { ...config, maxTokens }), /at least 2048/);
	}
	const model = prepareModel(manual, { ...config, maxTokens: 2048 });
	const payload = await capture(model);
	assert.equal(payload.max_tokens, 2048);
	assert.equal(payload.thinking.budget_tokens, 1024);
	validateAnthropicRequest(payload, 2048);
	for (const [max_tokens, budget_tokens] of [[1024, 1024], [1536, 512], [2048, 2048]]) {
		assert.throws(() => validateAnthropicRequest({ max_tokens, thinking: { type: "enabled", budget_tokens } }, 2048), /insufficient/);
	}
	assert.throws(() => validateAnthropicRequest({ max_tokens: 8193 }, 8192), /ceiling/);
	const adaptive = prepareModel(models.find((m) => m.id === "claude-opus-5-5"), { ...config, maxTokens: 1024 });
	validateAnthropicRequest(await capture(adaptive), 1024);
});
