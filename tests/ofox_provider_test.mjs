import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

// Use native TypeScript stripping and the installed host's exact dependencies
// in a private workspace; never install dependencies into the checkout/config.
let host = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(host, "package.json"))) {
	const versionFile = join(host, "install/current-version");
	if (existsSync(versionFile)) {
		host = join(host, "install/releases", readFileSync(versionFile, "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
		break;
	}
	if (dirname(host) === host) throw new Error("Could not locate Pi's installed package from its executable");
	host = dirname(host);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "ofox-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
cpSync(join(root, "extensions-pi/ofox"), join(scratch, "extension"), { recursive: true });
mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-coding-agent"]) {
	symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
}
const { createOfoxProvider, normalizeCatalogs, discoverModels, CATALOG_TTL_MS } =
	await import(join(scratch, "extension/provider.ts"));
const { googleIdentityApi } = await import(join(scratch, "extension/google-identity.ts"));
const ai = await import(join(host, "..", "pi-ai/dist/index.js"));
const { default: extensionFactory } = await import(join(scratch, "extension/index.ts"));
const { ModelRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } =
	await import(join(host, "dist/index.js"));
const cli = join(host, JSON.parse(readFileSync(join(host, "package.json"), "utf8")).bin.pi);

function row(id, overrides = {}) {
	return {
		id, name: id, canonical_slug: id.split("/").at(-1), aliases: [], is_deprecated: false,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		context_length: 100_000, top_provider: { context_length: 200_000, max_completion_tokens: 16_000 },
		pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002", input_cache_write_5m: "0.000005" },
		supported_parameters: ["tools", "reasoning"], supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
		...overrides,
	};
}
function catalogs(entries) {
	return {
		main: { data: entries },
		anthropic: { data: entries.filter((entry) => entry.id.startsWith("anthropic/")), has_more: false },
		google: { models: entries.filter((entry) => entry.id.startsWith("google/")).map((entry) => ({
			name: `models/${entry.id}`, supportedGenerationMethods: ["generateContent"],
		})) },
	};
}
const basicRows = [
	row("anthropic/claude-opus-5.5", { canonical_slug: "claude-opus-5-5" }),
	row("google/gemini-3.8-flash"),
	row("openai/gpt-6.1-sol"),
	row("qwen/qwen3-coder-next", { supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["tools"] }),
];
const basicCatalogs = catalogs(basicRows);
const basicModels = normalizeCatalogs(basicCatalogs);

test("live inventory, prices, capabilities, and native routing", () => {
	assert.equal(basicModels.length, 4);
	const claude = basicModels.find((entry) => entry.id.startsWith("anthropic/"));
	assert.equal(claude.provider, "ofox");
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, "https://api.ofox.io/anthropic");
	assert.equal(claude.cost.input, 4);
	assert.equal(claude.cost.output, 20);
	assert.ok(Math.abs(claude.cost.cacheRead - 0.2) < 1e-12);
	assert.equal(claude.cost.cacheWrite, 5);
	assert.equal(claude.contextWindow, 200_000);
	assert.equal(claude.maxTokens, 16_000);
	assert.equal(claude.compat.forceAdaptiveThinking, true);
	assert.equal(claude.compat.supportsTemperature, false);
	assert.equal(claude.compat.supportsMidConvoToolChanges, false);
	assert.equal(claude.compat.supportsMidConvoSystemMessages, false);
	assert.equal(claude.thinkingLevelMap.off, null);
	assert.equal(normalizeCatalogs(catalogs([row("anthropic/claude-opus-5.5")]))[0].compat.forceAdaptiveThinking, true);
	assert.equal(claude.promptCache, undefined);
	assert.equal(basicModels.find((entry) => entry.id.startsWith("google/")).api, "google-generative-ai");
	assert.equal(basicModels.find((entry) => entry.id.startsWith("openai/")).api, "openai-responses");
	assert.equal(basicModels.find((entry) => entry.id.startsWith("qwen/")).api, "openai-completions");
});

test("exclude unsupported operations, deprecated, duplicate, and malformed rows", () => {
	const result = normalizeCatalogs(catalogs([
		...basicRows, basicRows[0], row("retired/model", { is_deprecated: true }),
		row("openai/embedding", { supported_endpoints: ["/v1/embeddings"] }),
		row("openai/transcribe", { supported_endpoints: ["/v1/audio/transcriptions"] }),
		row("google/image", { architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } }),
		row("bad/price", { pricing: { prompt: "not-a-price", completion: "0.1" } }),
		row("bad/limits", { top_provider: { max_completion_tokens: -1 } }),
		row("bad/input", { architecture: { input_modalities: ["audio"], output_modalities: ["text"] } }),
	]));
	assert.deepEqual(result.map((entry) => entry.id), basicModels.map((entry) => entry.id));
	assert.throws(() => normalizeCatalogs(catalogs([])), /no usable chat models/);
	assert.throws(() => normalizeCatalogs({ ...basicCatalogs, main: {} }), /invalid model catalog/);
	assert.throws(() => normalizeCatalogs({ ...basicCatalogs, anthropic: { data: [], has_more: true } }), /pagination/);
});

test("unlisted native models use only advertised OpenAI-compatible endpoints", () => {
	const input = catalogs([row("anthropic/new-model"), row("google/new-model")]);
	input.anthropic.data = [];
	input.google.models = [];
	assert.ok(normalizeCatalogs(input).every((entry) => entry.api === "openai-responses"));
});

test("unknown models do not require a static inventory; output is bounded by context", () => {
	const input = catalogs([row("new-vendor/new-model", {
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		top_provider: { context_length: 5000, max_completion_tokens: 8000 },
		pricing: { prompt: "0", completion: "0", input_cache_write: "0.000001" },
	})]);
	const [model] = normalizeCatalogs(input);
	assert.equal(model.maxTokens, 5000);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.cost.cacheWrite, 1);
});

function fixtureFetch(input = basicCatalogs) {
	const calls = [];
	const payloads = { "/v1/models": input.main, "/anthropic/v1/models": input.anthropic, "/gemini/v1beta/models": input.google };
	return {
		calls,
		fetch: async (url, options) => {
			calls.push({ url, options });
			assert.equal(new URL(url).origin, "https://api.ofox.io");
			assert.equal(options.redirect, "error");
			assert.equal(options.headers.Authorization, "Bearer test-key");
			assert.ok(options.signal instanceof AbortSignal);
			return Response.json(payloads[new URL(url).pathname]);
		},
	};
}

test("discovery requests only fixed metadata endpoints", async () => {
	const fixture = fixtureFetch();
	assert.equal((await discoverModels("test-key", new AbortController().signal, fixture.fetch)).length, 4);
	assert.equal(fixture.calls.length, 3);
	assert.ok(fixture.calls.every((call) => call.options.signal.aborted));
});

test("HTTP, JSON, oversized-body, and network errors never echo secrets or provider bodies", async () => {
	for (const fetcher of [
		async () => new Response("secret-body", { status: 401 }),
		async () => new Response("secret-body"),
		async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
		async () => { throw new Error("secret-key"); },
	]) {
		await assert.rejects(discoverModels("secret-key", new AbortController().signal, fetcher), (error) => {
			assert.ok(!error.message.includes("secret"));
			return true;
		});
	}
});

test("cancellation stops discovery and sibling requests", async () => {
	const controller = new AbortController();
	const seen = [];
	const operation = discoverModels("test-key", controller.signal, async (_url, options) => {
		seen.push(options.signal);
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
	});
	controller.abort();
	await assert.rejects(operation, /cancelled or timed out/);
	assert.equal(seen.length, 3);
	assert.ok(seen.every((signal) => signal.aborted));
});

async function collection(discover, now = () => Date.now()) {
	const store = new ai.InMemoryModelsStore();
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify("ofox", async () => ({ type: "api_key", key: "test-key" }));
	const models = ai.createModels({ modelsStore: store, credentials });
	const provider = createOfoxProvider({ discover, now });
	models.setProvider(provider);
	return { models, store, provider };
}

test("native refresh persists snapshots; TTL skips do not slide checkedAt", async () => {
	let calls = 0;
	let time = 10_000;
	const { models, store } = await collection(async () => { calls++; return basicModels; }, () => time);
	assert.equal((await models.refresh()).errors.size, 0);
	assert.equal(calls, 1);
	assert.equal((await store.read("ofox")).checkedAt, time);
	time += 100;
	await models.refresh();
	assert.equal(calls, 1);
	assert.equal((await store.read("ofox")).checkedAt, 10_000);
	time += CATALOG_TTL_MS;
	await models.refresh();
	assert.equal(calls, 2);
	await models.refresh({ force: true });
	assert.equal(calls, 3);
});

test("cold offline startup restores cached state without network or persistence writes", async () => {
	let calls = 0;
	const { models, store } = await collection(async () => { calls++; throw new Error("must not fetch"); });
	await store.write("ofox", { models: basicModels, checkedAt: 10_000 });
	await models.refresh({ allowNetwork: false });
	assert.equal(calls, 0);
	assert.equal(models.getModels("ofox").length, 4);
	assert.equal((await store.read("ofox")).checkedAt, 10_000);
});

test("failed and aborted refreshes retain the last successful catalog", async () => {
	let failure = false;
	const { models, store } = await collection(async () => {
		if (failure) throw new Error("metadata unavailable");
		return basicModels;
	});
	await models.refresh();
	const initial = await store.read("ofox");
	failure = true;
	assert.equal((await models.refresh({ force: true })).errors.size, 1);
	assert.equal(models.getModels("ofox").length, 4);
	assert.deepEqual(await store.read("ofox"), initial);
	const controller = new AbortController();
	controller.abort();
	assert.equal((await models.refresh({ force: true, signal: controller.signal })).aborted, true);
	assert.deepEqual(await store.read("ofox"), initial);
});

test("fresh bootstrap state is not replaced by an older cache snapshot", async () => {
	const provider = createOfoxProvider({ discover: async () => basicModels, now: () => 20_000 });
	const context = { allowNetwork: true, credential: { type: "api_key", key: "test-key" }, signal: new AbortController().signal,
		publish: async (publication) => { publication.update?.(); return true; } };
	await provider.refreshModels(context);
	await provider.refreshModels({ ...context, allowNetwork: false, stored: { models: basicModels.slice(0, 1), checkedAt: 10_000 } });
	assert.equal(provider.getModels().length, 4);
});

test("generation-checked publication rejects stale refresh completions", async () => {
	let resolveOld;
	let calls = 0;
	const { models, store } = await collection(async () => {
		calls++;
		if (calls === 1) return new Promise((resolve) => { resolveOld = resolve; });
		return basicModels.slice(0, 1);
	});
	const old = models.refresh({ force: true });
	while (!resolveOld) await new Promise((resolve) => setImmediate(resolve));
	await models.refresh({ force: true });
	resolveOld(basicModels);
	await old;
	assert.equal(models.getModels("ofox").length, 1);
	assert.equal((await store.read("ofox")).models.length, 1);
});

test("cached models cannot redirect inference to arbitrary origins", async () => {
	const { models, store } = await collection(async () => basicModels);
	await store.write("ofox", { models: [{ ...basicModels[0], baseUrl: "https://evil.invalid" }], checkedAt: 10_000 });
	await models.refresh({ allowNetwork: false });
	assert.equal(models.getModels("ofox").length, 0);
});

function assistant(model, content = []) {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
		stopReason: "stop", timestamp: 1,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("Gemini wrapper translates same-model histories and restores all event/hook identities", async () => {
	const model = basicModels.find((entry) => entry.api === "google-generative-ai");
	const original = assistant(model, [{ type: "thinking", thinking: "", thinkingSignature: "signature" }]);
	const foreign = assistant({ ...model, provider: "other" });
	let hookCalls = 0;
	const run = (native, context, options) => {
		assert.equal(native.id, "gemini-3.8-flash");
		assert.equal(context.messages[0].model, native.id);
		assert.equal(context.messages[0].content[0].thinkingSignature, "signature");
		assert.equal(context.messages[1], foreign);
		const stream = ai.createAssistantMessageEventStream();
		void (async () => {
			await options.onPayload({ model: native.id }, native);
			await options.onProviderStreamEvent({}, native);
			const message = assistant(native, [{ type: "text", text: "こんにちは" }]);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "こんにちは", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		})();
		return stream;
	};
	const adapter = googleIdentityApi({ stream: run, streamSimple: run });
	for (const method of ["stream", "streamSimple"]) {
		const events = [];
		for await (const event of adapter[method](model, { messages: [original, foreign] }, {
			onPayload: (payload, publicModel) => { assert.equal(publicModel.id, model.id); assert.equal(payload.model, "gemini-3.8-flash"); hookCalls++; },
			onProviderStreamEvent: (_data, publicModel) => { assert.equal(publicModel.id, model.id); hookCalls++; },
		})) events.push(event);
		assert.equal(events.length, 3);
		assert.ok(events.every((event) => (event.partial ?? event.message).model === model.id));
		assert.equal(events[0].partial, events[2].message);
		assert.equal(original.model, model.id);
	}
	assert.equal(hookCalls, 4);
});

test("Gemini wrapper restores error identities and handles synchronous adapter failures", async () => {
	const model = basicModels.find((entry) => entry.api === "google-generative-ai");
	const failure = (native) => {
		const stream = ai.createAssistantMessageEventStream();
		stream.push({ type: "error", reason: "error", error: { ...assistant(native), stopReason: "error", errorMessage: "test" } });
		stream.end();
		return stream;
	};
	let adapter = googleIdentityApi({ stream: failure, streamSimple: failure });
	assert.equal((await adapter.streamSimple(model, { messages: [] }).result()).model, model.id);
	const throwing = () => { throw new Error("sensitive-provider-payload"); };
	adapter = googleIdentityApi({ stream: throwing, streamSimple: throwing });
	const result = await adapter.streamSimple(model, { messages: [] }).result();
	assert.equal(result.model, model.id);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "Ofox Gemini stream failed");
});

test("real native adapters assemble requests with stable public identities, without HTTP", async () => {
	const provider = createOfoxProvider();
	const originalFetch = globalThis.fetch;
	let httpCalls = 0;
	globalThis.fetch = async () => { httpCalls++; throw new Error("Unexpected HTTP request in unit test"); };
	try {
		for (const model of basicModels) {
			let payload;
			const context = ai.normalizeContext({ systemPrompt: "Unit test", tools: [{
				name: "lookup", description: "Unit test tool", parameters: ai.Type.Object({ value: ai.Type.String() }),
			}], messages: [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 }] });
			const result = await provider.streamSimple(model, context, {
				apiKey: "unit-test-key", reasoning: "high",
				onPayload: (assembled, publicModel) => {
					assert.equal(publicModel.id, model.id);
					payload = assembled;
					throw new Error("Unit test stops before HTTP");
				},
			}).result();
			assert.ok(payload, `Request payload was not assembled for ${model.id}`);
			assert.equal(result.model, model.id);
			assert.equal(result.stopReason, "error");
			if (model.api === "anthropic-messages") {
				assert.equal(payload.model, model.id);
				assert.equal(payload.thinking.type, "adaptive");
				assert.equal(payload.output_config.effort, "high");
				assert.equal(payload.tools[0].name, "lookup");
			} else if (model.api === "google-generative-ai") {
				assert.equal(payload.model, "gemini-3.8-flash");
				assert.equal(payload.config.thinkingConfig.thinkingLevel, "HIGH");
				assert.equal(payload.config.tools[0].functionDeclarations[0].name, "lookup");
			} else {
				assert.equal(payload.model, model.id);
				assert.equal(payload.tools[0].type, "function");
			}
		}
		assert.equal(httpCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("real Gemini conversion keeps signed tool calls, result IDs, images, and public identities", async () => {
	const model = basicModels.find((entry) => entry.api === "google-generative-ai");
	const history = assistant(model, [{ type: "toolCall", id: "call-test", name: "lookup", arguments: { value: "x" }, thoughtSignature: "b3BhcXVlLXNpZ25hdHVyZQ==" }]);
	const context = ai.normalizeContext({ messages: [history, {
		role: "toolResult", toolCallId: "call-test", toolName: "lookup", isError: false, timestamp: 2,
		content: [{ type: "text", text: "result" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
	}] });
	let payload;
	await createOfoxProvider().streamSimple(model, context, {
		apiKey: "unit-test-key", onPayload: (assembled) => { payload = assembled; throw new Error("Stop before HTTP"); },
	}).result();
	assert.equal(payload.contents[0].parts[0].functionCall.id, "call-test");
	assert.equal(payload.contents[0].parts[0].thoughtSignature, "b3BhcXVlLXNpZ25hdHVyZQ==");
	assert.equal(payload.contents[1].parts[0].functionResponse.id, "call-test");
	assert.equal(payload.contents[1].parts[0].functionResponse.parts[0].inlineData.mimeType, "image/png");
	assert.equal(history.model, model.id);
});

test("Gemini handoffs replay foreign tool history as text and preserve result images", async () => {
	const model = basicModels.find((entry) => entry.api === "google-generative-ai");
	const foreign = assistant({ ...model, provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" }, [{
		type: "toolCall", id: "foreign-call", name: "lookup", arguments: { value: "x" }, thoughtSignature: "b3RoZXI=",
	}]);
	let payload;
	const context = ai.normalizeContext({ messages: [foreign, {
		role: "toolResult", toolCallId: "foreign-call", toolName: "lookup", isError: false, timestamp: 2,
		content: [{ type: "text", text: "foreign result" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
	}] });
	await createOfoxProvider().streamSimple(model, context, { apiKey: "unit-test-key", onPayload: (assembled) => {
		payload = assembled; throw new Error("Stop before HTTP");
	} }).result();
	assert.match(payload.contents[0].parts[0].text, /Tool call lookup/);
	assert.match(payload.contents[1].parts[1].text, /foreign result/);
	assert.equal(payload.contents[1].parts[2].inlineData.mimeType, "image/png");
	assert.ok(payload.contents.every((entry) => entry.parts.every((part) => !part.functionCall && !part.functionResponse && !part.thoughtSignature)));
	assert.equal(foreign.content[0].type, "toolCall");
});

test("CLI and SDK factories register without creating a runtime or discovering models", async () => {
	const originalEntry = process.argv[1];
	const originalCreate = ModelRuntime.create;
	const originalFetch = globalThis.fetch;
	let runtimeCalls = 0;
	let networkCalls = 0;
	try {
		ModelRuntime.create = () => { runtimeCalls++; throw new Error("Factory must not create a runtime"); };
		globalThis.fetch = async () => { networkCalls++; throw new Error("Factory must not perform discovery"); };
		for (const entry of [join(host, "dist/cli.js"), cli, originalEntry]) {
			process.argv[1] = entry;
			let registered;
			let commands = 0;
			assert.equal(extensionFactory({
				registerProvider: (provider) => { registered = provider; },
				registerCommand: (name) => { assert.equal(name, "ofox-refresh"); commands++; },
			}), undefined);
			assert.equal(registered.id, "ofox");
			assert.equal(registered.getModels().length, 0);
			assert.equal(commands, 1);
		}
		assert.equal(runtimeCalls, 0);
		assert.equal(networkCalls, 0);
	} finally {
		process.argv[1] = originalEntry;
		ModelRuntime.create = originalCreate;
		globalThis.fetch = originalFetch;
	}
});

test("primary runtime restores injected cached models before initial model selection", async () => {
	const agent = join(scratch, "primary-agent");
	mkdirSync(agent);
	const store = new ai.InMemoryModelsStore();
	const credentials = new ai.InMemoryCredentialStore();
	await store.write("ofox", { models: basicModels, checkedAt: 10_000 });
	await credentials.modify("ofox", async () => ({ type: "api_key", key: "unit-test-key" }));
	const originalWrite = store.write.bind(store);
	let writes = 0;
	store.write = async (...args) => { writes++; return originalWrite(...args); };
	const runtime = await ModelRuntime.create({ credentials, modelsStore: store, modelsPath: null, refreshOnCreate: false });
	const services = await createAgentSessionServices({
		cwd: agent, agentDir: agent, modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "ofox", defaultModel: basicModels[0].id }),
		resourceLoaderOptions: {
			extensionFactories: [extensionFactory], noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
		},
	});
	assert.equal(services.modelRuntime, runtime);
	assert.deepEqual(services.diagnostics, []);
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	assert.equal((await runtime.getAvailable("ofox")).length, 4);
	const { session } = await createAgentSessionFromServices({
		services, sessionManager: SessionManager.inMemory(agent), noTools: "all",
	});
	try {
		assert.equal(session.model.provider, "ofox");
		assert.equal(session.model.id, basicModels[0].id);
		assert.equal(writes, 0);
		assert.equal((await store.read("ofox")).checkedAt, 10_000);
		assert.equal(existsSync(join(agent, "models-store.json")), false);
	} finally {
		session.dispose();
	}
});

function cliFixture(name, models) {
	const agent = join(scratch, name);
	mkdirSync(agent);
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ ofox: { type: "api_key", key: "unit-test-key" } }));
	writeFileSync(join(agent, "models-store.json"), JSON.stringify({ ofox: { models, checkedAt: 10_000 } }));
	const guard = join(agent, "no-network.cjs");
	writeFileSync(guard, 'globalThis.fetch = async () => { process.stderr.write("UNEXPECTED_NETWORK\\n"); throw new Error("Network forbidden in CLI fixture"); };');
	return {
		agent,
		run: (args) => {
			const result = spawnSync(process.execPath, [cli, "--no-session", "--no-extensions", "--no-skills",
				"--no-context-files", "--no-prompt-templates", "--no-themes", "--extension", join(scratch, "extension/index.ts"), ...args], {
				cwd: agent, input: "", encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
				env: {
					PATH: process.env.PATH, HOME: agent, PI_CODING_AGENT_DIR: agent,
					PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NODE_OPTIONS: `--require=${guard}`,
					NODE_COMPILE_CACHE: join(scratch, "cli-node-cache"), XDG_CACHE_HOME: join(agent, "cache"),
					XDG_RUNTIME_DIR: join(agent, "runtime"),
				},
			});
			assert.ifError(result.error);
			assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
			return result;
		},
	};
}

test("CLI lists cached Ofox models online and offline without discovery or catalog writes", () => {
	const { agent, run } = cliFixture("cli-cached", basicModels);
	const before = readFileSync(join(agent, "models-store.json"), "utf8");
	for (const flags of [[], ["--offline"]]) {
		const result = run([...flags, "--list-models", "ofox"]);
		assert.equal(result.status, 0, result.stderr);
		for (const model of basicModels) assert.ok(result.stdout.includes(model.id), result.stdout);
		assert.equal(readFileSync(join(agent, "models-store.json"), "utf8"), before);
	}
});

test("empty-cache CLI does not discover models or accept an uncached Ofox override", () => {
	const { run } = cliFixture("cli-empty", []);
	const listed = run(["--list-models", "ofox"]);
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /No models available|No models matching/);
	const selected = run(["--model", `ofox/${basicModels[0].id}`, "--mode", "json"]);
	assert.equal(selected.status, 1);
	assert.match(selected.stderr, /not found/);
});

test("SDK loading leaves bootstrap to the host's isolated runtime and stored credentials", async () => {
	const agent = join(scratch, "agent");
	mkdirSync(agent);
	writeFileSync(join(agent, "models-store.json"), JSON.stringify({ ofox: { models: basicModels, checkedAt: 10_000 } }));
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ ofox: { type: "api_key", key: "unit-test-key" } }));
	const names = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "OFOX_API_KEY"];
	const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	const originalFetch = globalThis.fetch;
	let registered;
	let refreshCommand;
	try {
		process.env.PI_CODING_AGENT_DIR = agent;
		process.env.PI_OFFLINE = "1";
		delete process.env.OFOX_API_KEY;
		globalThis.fetch = async () => { throw new Error("Unexpected HTTP request in offline bootstrap"); };
		await extensionFactory({
			registerProvider: (provider) => { registered = provider; },
			registerCommand: (name, command) => { assert.equal(name, "ofox-refresh"); refreshCommand = command; },
		});
		assert.equal(registered.id, "ofox");
		assert.equal(registered.getModels().length, 0); // Factory must not read default storage in an SDK.
		const runtime = await ModelRuntime.create({
			authPath: join(agent, "auth.json"), modelsPath: join(agent, "models.json"), refreshOnCreate: false,
		});
		runtime.registerNativeProvider(registered);
		await runtime.refresh({ allowNetwork: false, providers: ["ofox"] });
		assert.equal(registered.getModels().length, 4);
		assert.equal((await runtime.getAvailable("ofox")).length, 4);
		let notification;
		await refreshCommand.handler("", { ui: { notify: (message) => { notification = message; } } });
		assert.match(notification, /disabled in offline mode/);
		assert.equal(JSON.parse(readFileSync(join(agent, "models-store.json"))).ofox.checkedAt, 10_000);
	} finally {
		globalThis.fetch = originalFetch;
		for (const name of names) {
			if (original[name] === undefined) delete process.env[name];
			else process.env[name] = original[name];
		}
	}
});
