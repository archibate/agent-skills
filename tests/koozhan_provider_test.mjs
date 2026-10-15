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
const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "koozhan-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
cpSync(join(root, "extensions-pi/koozhan"), join(scratch, "extension"), { recursive: true });
mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-coding-agent"]) {
	symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
}
const { createKoozhanProvider, normalizeCatalog, discoverModels, shortCacheFloor, CATALOG_TTL_MS } =
	await import(join(scratch, "extension/provider.ts"));
const ai = await import(join(host, "..", "pi-ai/dist/index.js"));
const { default: extensionFactory } = await import(join(scratch, "extension/index.ts"));
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } =
	await import(join(host, "dist/index.js"));
const cli = join(host, JSON.parse(readFileSync(join(host, "package.json"), "utf8")).bin.pi);

// Mirrors the shape of GET /v1/relay/models.
function row(id, overrides = {}) {
	const { pricing, ...rest } = overrides;
	return {
		id, display_name: `Display ${id}`, chat_selectable: true, status: "available", max_tokens: 1_000_000,
		platform: id.startsWith("claude-") ? "claude_apikey" : "wa_018_openai",
		pricing: {
			input_usd_per_1m_tokens: 1, output_usd_per_1m_tokens: 5, cache_read_usd_per_1m_tokens: 0.05,
			cache_creation_5m_usd_per_1m_tokens: 1.25, cache_creation_1h_usd_per_1m_tokens: 2,
			official_input_usd_per_1m_tokens: 4, retail_multiplier: 0.25, ...pricing,
		},
		...rest,
	};
}
const catalog = (rows) => ({ api: "openai-completions", base_url: "https://api.koozhan.com/v1", models: rows });
const basicRows = [row("claude-opus-5-5"), row("claude-fable-5"), row("gpt-6.1-sol", { max_tokens: 372_000 })];
const basicModels = normalizeCatalog(catalog(basicRows));

test("live inventory and prices, Pi capabilities, and native routing", () => {
	assert.deepEqual(basicModels.map((model) => model.id), ["claude-fable-5", "claude-opus-5-5", "gpt-6.1-sol"]);
	const claude = basicModels.find((model) => model.id === "claude-opus-5-5");
	assert.equal(claude.provider, "koozhan");
	assert.equal(claude.name, "Display claude-opus-5-5");
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, "https://api.koozhan.com");
	assert.deepEqual(claude.cost, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 });
	assert.equal(claude.contextWindow, 1_000_000);
	assert.equal(claude.maxTokens, 128_000);
	assert.equal(claude.reasoning, true);
	assert.deepEqual(claude.input, ["text", "image"]);
	assert.equal(claude.compat.forceAdaptiveThinking, true);
	assert.equal(claude.compat.supportsMidConvoEffort, true);
	assert.deepEqual(claude.promptCache, { short: 300, long: 3600 });
	assert.equal(claude.thinkingLevelMap.max, "max");
	// Server-side fallback would name built-in Anthropic models Koozhan may not route.
	assert.equal(basicModels.find((model) => model.id === "claude-fable-5").compat.allowedFallbackModels, undefined);
	const gpt = basicModels.find((model) => model.id === "gpt-6.1-sol");
	assert.equal(gpt.api, "openai-responses");
	assert.equal(gpt.baseUrl, "https://api.koozhan.com/v1");
	assert.equal(gpt.contextWindow, 272_000); // The smaller of Koozhan's and Pi's limits.
	assert.equal(gpt.cost.tiers, undefined);
	assert.equal(gpt.compat, undefined);
	assert.equal(gpt.promptCache, undefined);
	const limited = normalizeCatalog(catalog([row("claude-sonnet-4-6", { max_tokens: 200_000 })]))[0];
	assert.equal(limited.contextWindow, 200_000);
});

test("exclude DeepSeek, other families, time-of-use prices, unavailable, unknown, duplicate, and malformed rows", () => {
	const result = normalizeCatalog(catalog([
		...basicRows, basicRows[0],
		row("deepseek-v4-flash", { platform: "deepseek" }),
		row("gemini-4-argon"),
		row("gpt-6-sol", { pricing: { pricing_mode: "time_of_use" } }),
		row("gpt-5.4", { chat_selectable: false, status: "unavailable" }),
		row("gpt-5.4-mini", { status: "unavailable" }),
		row("claude-future-9"),
		row("claude-opus-5", { pricing: { input_usd_per_1m_tokens: "1" } }),
		row("claude-sonnet-5", { pricing: { output_usd_per_1m_tokens: -1 } }),
		row("claude-sonnet-5-5", { max_tokens: 0 }),
		row("claude bad/id"),
		{ id: 42 }, null,
	]));
	assert.deepEqual(result, basicModels);
	assert.throws(() => normalizeCatalog(catalog([])), /no usable chat models/);
	assert.throws(() => normalizeCatalog(catalog([row("deepseek-v4-pro")])), /no usable chat models/);
	assert.throws(() => normalizeCatalog({}), /invalid model catalog/);
	assert.throws(() => normalizeCatalog(catalog(Array(2001).fill(basicRows[0]))), /invalid model catalog/);
});

test("missing cache prices default to zero", () => {
	const [model] = normalizeCatalog(catalog([row("gpt-5.5", { pricing: {
		cache_read_usd_per_1m_tokens: undefined, cache_creation_5m_usd_per_1m_tokens: undefined,
	} })]));
	assert.equal(model.cost.cacheRead, 0);
	assert.equal(model.cost.cacheWrite, 0);
});

test("discovery requests only the fixed catalog endpoint", async () => {
	const calls = [];
	const models = await discoverModels("test-key", new AbortController().signal, async (url, options) => {
		calls.push(url);
		assert.equal(options.redirect, "error");
		assert.equal(options.headers.Authorization, "Bearer test-key");
		assert.equal(options.headers["x-api-key"], "test-key");
		assert.ok(options.signal instanceof AbortSignal);
		return Response.json(catalog(basicRows));
	});
	assert.deepEqual(models, basicModels);
	assert.deepEqual(calls, ["https://api.koozhan.com/v1/relay/models"]);
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

test("cancellation stops discovery", async () => {
	const controller = new AbortController();
	let seen;
	const operation = discoverModels("test-key", controller.signal, async (_url, options) => {
		seen = options.signal;
		return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
	});
	controller.abort();
	await assert.rejects(operation, /cancelled or timed out/);
	assert.equal(seen.aborted, true);
});

async function collection(discover, now = () => Date.now()) {
	const store = new ai.InMemoryModelsStore();
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify("koozhan", async () => ({ type: "api_key", key: "test-key" }));
	const models = ai.createModels({ modelsStore: store, credentials });
	models.setProvider(createKoozhanProvider({ discover, now }));
	return { models, store };
}

test("native refresh persists snapshots; TTL skips do not slide checkedAt", async () => {
	let calls = 0;
	let time = 10_000;
	const { models, store } = await collection(async () => { calls++; return basicModels; }, () => time);
	assert.equal((await models.refresh()).errors.size, 0);
	assert.equal(calls, 1);
	assert.equal((await store.read("koozhan")).checkedAt, time);
	time += 100;
	await models.refresh();
	assert.equal(calls, 1);
	assert.equal((await store.read("koozhan")).checkedAt, 10_000);
	time += CATALOG_TTL_MS;
	await models.refresh();
	assert.equal(calls, 2);
	await models.refresh({ force: true });
	assert.equal(calls, 3);
});

test("cold offline startup restores cached state without network or persistence writes", async () => {
	let calls = 0;
	const { models, store } = await collection(async () => { calls++; throw new Error("must not fetch"); });
	await store.write("koozhan", { models: basicModels, checkedAt: 10_000 });
	await models.refresh({ allowNetwork: false });
	assert.equal(calls, 0);
	assert.equal(models.getModels("koozhan").length, 3);
	assert.equal((await store.read("koozhan")).checkedAt, 10_000);
});

test("failed and aborted refreshes retain the last successful catalog", async () => {
	let failure = false;
	const { models, store } = await collection(async () => {
		if (failure) throw new Error("metadata unavailable");
		return basicModels;
	});
	await models.refresh();
	const initial = await store.read("koozhan");
	failure = true;
	assert.equal((await models.refresh({ force: true })).errors.size, 1);
	assert.equal(models.getModels("koozhan").length, 3);
	assert.deepEqual(await store.read("koozhan"), initial);
	const controller = new AbortController();
	controller.abort();
	assert.equal((await models.refresh({ force: true, signal: controller.signal })).aborted, true);
	assert.deepEqual(await store.read("koozhan"), initial);
});

test("fresh bootstrap state is not replaced by an older cache snapshot", async () => {
	const provider = createKoozhanProvider({ discover: async () => basicModels, now: () => 20_000 });
	const context = { allowNetwork: true, credential: { type: "api_key", key: "test-key" }, signal: new AbortController().signal,
		publish: async (publication) => { publication.update?.(); return true; } };
	await provider.refreshModels(context);
	await provider.refreshModels({ ...context, allowNetwork: false, stored: { models: basicModels.slice(0, 1), checkedAt: 10_000 } });
	assert.equal(provider.getModels().length, 3);
});

test("cached models cannot redirect inference to arbitrary origins or APIs", async () => {
	const { models, store } = await collection(async () => basicModels);
	await store.write("koozhan", { models: [
		{ ...basicModels[0], baseUrl: "https://evil.invalid" },
		{ ...basicModels[2], api: "openai-completions" },
		{ ...basicModels[1], cost: { ...basicModels[1].cost, input: -1 } },
	], checkedAt: 10_000 });
	await models.refresh({ allowNetwork: false });
	assert.equal(models.getModels("koozhan").length, 0);
});

function payloadContext() {
	return ai.normalizeContext({ systemPrompt: "Unit test", tools: [{
		name: "lookup", description: "Unit test tool", parameters: ai.Type.Object({ value: ai.Type.String() }),
	}], messages: [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 }] });
}
async function assemble(model, options = {}) {
	let payload;
	const result = await createKoozhanProvider().streamSimple(model, payloadContext(), {
		apiKey: "unit-test-key", ...options,
		onPayload: (assembled, publicModel) => {
			assert.equal(publicModel.id, model.id);
			payload = assembled;
			throw new Error("Unit test stops before HTTP");
		},
	}).result();
	assert.ok(payload, `Request payload was not assembled for ${model.id}`);
	assert.equal(result.model, model.id);
	assert.equal(result.stopReason, "error");
	return payload;
}
function cacheMarkers(payload) {
	const markers = [];
	JSON.stringify(payload, (key, value) => {
		if (key === "cache_control") markers.push(value);
		return value;
	});
	return markers;
}

test("real adapters assemble requests; Claude 'none' cache retention becomes an explicit 5m marker", async () => {
	const originalFetch = globalThis.fetch;
	let httpCalls = 0;
	globalThis.fetch = async () => { httpCalls++; throw new Error("Unexpected HTTP request in unit test"); };
	try {
		const claude = basicModels.find((model) => model.id === "claude-opus-5-5");
		const claudePayload = await assemble(claude, { reasoning: "high" });
		assert.equal(claudePayload.model, "claude-opus-5-5");
		assert.equal(claudePayload.thinking.type, "adaptive");
		assert.equal(claudePayload.tools[0].name, "lookup");
		for (const [retention, expected] of [["none", { type: "ephemeral" }], ["short", { type: "ephemeral" }], ["long", { type: "ephemeral", ttl: "1h" }]]) {
			const markers = cacheMarkers(await assemble(claude, { cacheRetention: retention }));
			assert.ok(markers.length > 0, `${retention} must send cache markers`);
			assert.ok(markers.every((marker) => assert.deepEqual(marker, expected) === undefined));
		}
		const gptPayload = await assemble(basicModels.find((model) => model.id === "gpt-6.1-sol"), { reasoning: "high", cacheRetention: "none" });
		assert.equal(gptPayload.model, "gpt-6.1-sol");
		assert.equal(gptPayload.tools[0].type, "function");
		assert.equal(httpCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cache floor only rewrites 'none' and never mutates caller options", () => {
	const seen = [];
	const record = (_model, _context, options) => { seen.push(options); return "stream"; };
	const floor = shortCacheFloor({ stream: record, streamSimple: record, extra: 1 });
	assert.equal(floor.extra, 1);
	const none = { cacheRetention: "none", sessionId: "s" };
	for (const method of ["stream", "streamSimple"]) {
		assert.equal(floor[method]({}, {}, none), "stream");
		assert.deepEqual(seen.at(-1), { cacheRetention: "short", sessionId: "s" });
		const long = { cacheRetention: "long" };
		floor[method]({}, {}, long);
		assert.equal(seen.at(-1), long);
		floor[method]({}, {}, undefined);
		assert.equal(seen.at(-1), undefined);
	}
	assert.deepEqual(none, { cacheRetention: "none", sessionId: "s" });
});

test("CLI and SDK factories register without creating a runtime or discovering models", async () => {
	const originalCreate = ModelRuntime.create;
	const originalFetch = globalThis.fetch;
	let runtimeCalls = 0;
	let networkCalls = 0;
	try {
		ModelRuntime.create = () => { runtimeCalls++; throw new Error("Factory must not create a runtime"); };
		globalThis.fetch = async () => { networkCalls++; throw new Error("Factory must not perform discovery"); };
		let registered;
		let commands = 0;
		assert.equal(extensionFactory({
			registerProvider: (provider) => { registered = provider; },
			registerCommand: (name) => { assert.equal(name, "koozhan-refresh"); commands++; },
		}), undefined);
		assert.equal(registered.id, "koozhan");
		assert.equal(registered.getModels().length, 0);
		assert.equal(commands, 1);
		assert.equal(runtimeCalls, 0);
		assert.equal(networkCalls, 0);
	} finally {
		ModelRuntime.create = originalCreate;
		globalThis.fetch = originalFetch;
	}
});

test("primary runtime restores cached routing before selecting a Koozhan model", async () => {
	const agent = join(scratch, "primary-agent");
	mkdirSync(agent);
	const store = new ai.InMemoryModelsStore();
	const credentials = new ai.InMemoryCredentialStore();
	await store.write("koozhan", { models: basicModels, checkedAt: 10_000 });
	await credentials.modify("koozhan", async () => ({ type: "api_key", key: "unit-test-key" }));
	const runtime = await ModelRuntime.create({ credentials, modelsStore: store, modelsPath: null, refreshOnCreate: false });
	const services = await createAgentSessionServices({
		cwd: agent, agentDir: agent, modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "koozhan", defaultModel: "claude-opus-5-5" }),
		resourceLoaderOptions: {
			extensionFactories: [extensionFactory], noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
		},
	});
	assert.deepEqual(services.diagnostics, []);
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	assert.equal((await runtime.getAvailable("koozhan")).length, 3);
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(agent), noTools: "all" });
	try {
		assert.equal(session.model.provider, "koozhan");
		assert.equal(session.model.id, "claude-opus-5-5");
		assert.equal(session.model.baseUrl, "https://api.koozhan.com");
		assert.equal((await store.read("koozhan")).checkedAt, 10_000);
	} finally {
		session.dispose();
	}
});

function cliFixture(name, models) {
	const agent = join(scratch, name);
	mkdirSync(agent);
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ koozhan: { type: "api_key", key: "unit-test-key" } }));
	writeFileSync(join(agent, "models-store.json"), JSON.stringify({ koozhan: { models, checkedAt: 10_000 } }));
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

test("CLI lists cached Koozhan models online and offline without discovery or catalog writes", () => {
	const { agent, run } = cliFixture("cli-cached", basicModels);
	const before = readFileSync(join(agent, "models-store.json"), "utf8");
	for (const flags of [[], ["--offline"]]) {
		const result = run([...flags, "--list-models", "koozhan"]);
		assert.equal(result.status, 0, result.stderr);
		for (const model of basicModels) assert.ok(result.stdout.includes(model.id), result.stdout);
		assert.equal(readFileSync(join(agent, "models-store.json"), "utf8"), before);
	}
});

test("refresh command is disabled offline and leaves the cache untouched", async () => {
	const agent = join(scratch, "offline-command");
	mkdirSync(agent);
	const original = process.env.PI_OFFLINE;
	let refreshCommand;
	try {
		process.env.PI_OFFLINE = "1";
		extensionFactory({ registerProvider: () => {}, registerCommand: (_name, command) => { refreshCommand = command; } });
		let notification;
		await refreshCommand.handler("", { ui: { notify: (message) => { notification = message; } } });
		assert.match(notification, /disabled in offline mode/);
	} finally {
		if (original === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = original;
	}
});
