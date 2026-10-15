import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

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
const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "cache-compact-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
cpSync(join(root, "extensions-pi/cache-compact"), join(scratch, "extension"), { recursive: true });
mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-coding-agent"]) {
	symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
}
const { createCacheCompact } = await import(join(scratch, "extension/index.ts"));
const { splicePayload, tailMessages, isWarmReplay, buildInstruction } = await import(join(scratch, "extension/compaction.ts"));
const ai = await import(join(host, "..", "pi-ai/dist/index.js"));
const { openAIResponsesApi } = await import(join(host, "..", "pi-ai/dist/compat.js"));
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } =
	await import(join(host, "dist/index.js"));

// ---------------------------------------------------------------------------
// Pure helpers

test("Anthropic splice keeps the captured prefix and strips tail breakpoints and effort restatements", () => {
	const captured = { model: "m", system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [], output_config: { effort: "low" } }], max_tokens: 64 };
	const built = { model: "m", messages: [{ role: "system", content: [], output_config: { effort: "low" } },
		{ role: "assistant", content: [{ type: "text", text: "a" }] },
		{ role: "user", content: [{ type: "text", text: "sum", cache_control: { type: "ephemeral" } }] },
		{ role: "system", content: [], output_config: { effort: "low" } }], max_tokens: 9 };
	const before = structuredClone(captured);
	const spliced = splicePayload("anthropic-messages", captured, built);
	assert.deepEqual(captured, before);
	assert.equal(spliced.max_tokens, 64);
	assert.deepEqual(spliced.system, captured.system);
	assert.deepEqual(spliced.messages.slice(0, 2), captured.messages);
	assert.deepEqual(spliced.messages.slice(2), [
		{ role: "assistant", content: [{ type: "text", text: "a" }] },
		{ role: "user", content: [{ type: "text", text: "sum" }] },
		{ role: "system", content: [], output_config: { effort: "low" } },
	]);
});

test("Responses splice drops the built prompt and appends the tail items", () => {
	const captured = { model: "m", input: [{ role: "developer", content: "S" }, { role: "user", content: [] }], prompt_cache_key: "k" };
	const built = { model: "m", input: [{ role: "developer", content: "" }, { type: "message", role: "assistant", content: [] }, { role: "user", content: [] }] };
	const spliced = splicePayload("openai-responses", captured, built);
	assert.equal(spliced.prompt_cache_key, "k");
	assert.deepEqual(spliced.input, [...captured.input, ...built.input.slice(1)]);
	assert.equal(splicePayload("openai-completions", captured, built), undefined);
	assert.equal(splicePayload("anthropic-messages", { messages: "x" }, built), undefined);
});

test("tail messages follow the captured leaf; context-changing entries refuse", () => {
	const message = (id, role) => ({ type: "message", id, message: { role, content: [{ type: "text", text: id }], timestamp: 1 } });
	const entries = [message("u1", "user"), message("a1", "assistant"), { type: "usage", id: "w" }, { type: "label", id: "l" },
		{ type: "custom_message", id: "c", customType: "note", content: "n", display: true, timestamp: 1 }];
	const tail = tailMessages(entries, "u1");
	assert.deepEqual(tail.map((m) => m.role), ["assistant", "custom"]);
	assert.deepEqual(tailMessages(entries, "c"), []);
	assert.equal(tailMessages(entries, "gone"), undefined);
	assert.equal(tailMessages(entries, null), undefined);
	for (const type of ["model_change", "thinking_level_change", "compaction", "branch_summary", "context_edit"]) {
		assert.equal(tailMessages([...entries, { type, id: "x" }], "u1"), undefined, type);
	}
});

test("warm replays are recognised and instructions carry custom focus", () => {
	assert.equal(isWarmReplay({ max_tokens: 1 }), true);
	assert.equal(isWarmReplay({ max_output_tokens: 1 }), true);
	assert.equal(isWarmReplay({ max_tokens: 64 }), false);
	assert.match(buildInstruction(" files only "), /Additional focus: files only$/);
	assert.doesNotMatch(buildInstruction(), /Additional focus/);
});

// ---------------------------------------------------------------------------
// Real Pi session, real Anthropic adapter, mocked HTTP

function sse(events) {
	return new Response(events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } });
}
function anthropicReply(blocks, usage = {}) {
	const events = [{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "fake-claude", content: [],
		stop_reason: null, usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } } }];
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name: block.name, input: {} } },
				{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } });
		}
		events.push({ type: "content_block_stop", index });
	});
	const stop = blocks.some((block) => block.type === "tool") ? "tool_use" : "end_turn";
	events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 7 } }, { type: "message_stop" });
	return sse(events);
}

const requests = [];
let replies = [];
let clock = 1_000_000;
const originalFetch = globalThis.fetch;
beforeEach(() => {
	requests.length = 0;
	replies = [];
	clock = 1_000_000;
});
after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.url;
	if (!url.startsWith("https://fake.invalid")) throw new Error(`Unexpected HTTP request to ${url}`);
	requests.push(JSON.parse(init.body));
	const reply = replies.shift();
	if (!reply) throw new Error("No scripted reply");
	return reply();
};

function fakeProvider(pi) {
	pi.registerProvider("fake", {
		baseUrl: "https://fake.invalid", apiKey: "unit-test-key", api: "anthropic-messages",
		models: [{ id: "fake-claude", name: "Fake Claude", reasoning: false, input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200_000, maxTokens: 4096,
			promptCache: { short: 300, long: 3600 } }],
	});
}

async function newSession(name) {
	const agent = join(scratch, name);
	mkdirSync(agent);
	const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false });
	const services = await createAgentSessionServices({
		cwd: agent, agentDir: agent, modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "fake", defaultModel: "fake-claude", cacheWarming: "off",
			compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 1 } }),
		resourceLoaderOptions: {
			extensionFactories: [fakeProvider, createCacheCompact({ now: () => clock })], noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
		},
	});
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(agent), noTools: "all" });
	const notices = [];
	session.extensionRunner?.setUIContext?.({ notify: (message, level) => notices.push({ message, level }) });
	return { session, notices };
}

async function twoTurns(session) {
	replies.push(() => anthropicReply([{ type: "text", text: "first answer" }]), () => anthropicReply([{ type: "text", text: "second answer" }]));
	await session.prompt("first question");
	await session.prompt("second question");
	assert.equal(requests.length, 2);
}

function isDefaultSummaryRequest(body) {
	return JSON.stringify(body.system ?? "").includes("context summarization assistant");
}

test("compaction resends the last request with the reply and an instruction appended", async () => {
	const { session } = await newSession("splice");
	try {
		await twoTurns(session);
		const turn = requests[1];
		clock += 60_000;
		replies.push(() => anthropicReply([{ type: "text", text: "## Goal\nCached summary" }], { cache_read_input_tokens: 900 }));
		const result = await session.compact("keep it short");
		assert.equal(requests.length, 3);
		const compaction = requests[2];
		assert.equal(isDefaultSummaryRequest(compaction), false);
		assert.deepEqual(compaction.system, turn.system);
		assert.deepEqual(compaction.tools, turn.tools);
		assert.equal(compaction.max_tokens, turn.max_tokens);
		assert.deepEqual(compaction.messages.slice(0, turn.messages.length), turn.messages);
		const tail = compaction.messages.slice(turn.messages.length);
		assert.deepEqual(tail.map((m) => m.role), ["assistant", "user"]);
		assert.equal(tail[0].content[0].text, "second answer");
		assert.match(tail[1].content[0].text, /^\[Context compaction\][\s\S]*Additional focus: keep it short$/);
		assert.doesNotMatch(JSON.stringify(tail), /cache_control/);
		assert.match(result.summary, /^## Goal\nCached summary/);
		assert.equal(result.usage.cacheRead, 900);
	} finally {
		session.dispose();
	}
});

test("stale caches, tool calls and failed requests fall back to Pi's compaction", async () => {
	const defaultSummary = () => anthropicReply([{ type: "text", text: "## Goal\nDefault summary" }]);

	const stale = await newSession("stale");
	try {
		await twoTurns(stale.session);
		clock += 271_000;
		replies.push(defaultSummary, defaultSummary);
		const result = await stale.session.compact();
		assert.equal(isDefaultSummaryRequest(requests[2]), true);
		assert.match(result.summary, /Default summary/);
	} finally {
		stale.session.dispose();
	}

	for (const [name, reply, notice] of [
		["tool", () => anthropicReply([{ type: "tool", name: "lookup" }]), /called a tool/],
		["error", () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad splice" } }),
			{ status: 400, headers: { "content-type": "application/json" } }), /bad splice/],
	]) {
		requests.length = 0;
		const { session, notices } = await newSession(name);
		try {
			await twoTurns(session);
			replies.push(reply, defaultSummary, defaultSummary);
			const result = await session.compact();
			assert.equal(isDefaultSummaryRequest(requests[2]), false, name);
			assert.equal(isDefaultSummaryRequest(requests[3]), true, name);
			assert.match(result.summary, /Default summary/, name);
			assert.match(notices.map((n) => n.message).join("\n"), notice, name);
		} finally {
			session.dispose();
		}
	}
});

test("after a compaction the next turn is captured again", async () => {
	const { session } = await newSession("twice");
	try {
		await twoTurns(session);
		replies.push(() => anthropicReply([{ type: "text", text: "## Goal\nFirst" }]),
			() => anthropicReply([{ type: "text", text: "third answer" }]),
			() => anthropicReply([{ type: "text", text: "## Goal\nSecond" }]));
		await session.compact();
		await session.prompt("third question");
		const turn = requests[3];
		assert.match(JSON.stringify(turn.messages), /First/);
		const result = await session.compact();
		assert.equal(requests.length, 5);
		assert.deepEqual(requests[4].messages.slice(0, turn.messages.length), turn.messages);
		assert.match(result.summary, /^## Goal\nSecond/);
	} finally {
		session.dispose();
	}
});

// ---------------------------------------------------------------------------
// Real Responses adapter: the built tail matches what Pi would send next.

test("Responses splice equals the request Pi would build for the next turn", async () => {
	const model = { id: "gpt-test", name: "GPT test", api: "openai-responses", provider: "fake-openai", baseUrl: "https://fake.invalid/v1",
		reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
	const tools = [{ name: "lookup", description: "Look up", parameters: ai.Type.Object({ key: ai.Type.String() }) }];
	const user = { role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 };
	const reply = (textSignature) => ({ role: "assistant", content: [{ type: "text", text: "a", textSignature }], api: model.api,
		provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const instruction = { role: "user", content: [{ type: "text", text: "sum" }], timestamp: 3 };
	const assemble = async (context) => {
		let payload;
		await openAIResponsesApi().streamSimple(model, ai.normalizeContext(context), { apiKey: "k", sessionId: "s", onPayload: (p) => { payload = p; throw new Error("stop"); } }).result();
		return payload;
	};
	const captured = await assemble({ systemPrompt: "S", tools, messages: [user] });
	// Real replies carry the provider's item id, so the splice is exactly Pi's next request.
	const signed = reply(JSON.stringify({ v: 1, id: "msg_real", phase: "final_answer" }));
	assert.deepEqual(splicePayload("openai-responses", captured, await assemble({ messages: [signed, instruction] })),
		await assemble({ systemPrompt: "S", tools, messages: [user, signed, instruction] }));
	// Unsigned replies get position ids; the splice keeps them unique instead.
	const unsigned = splicePayload("openai-responses", captured, await assemble({ messages: [reply(undefined), instruction] }));
	const expected = await assemble({ systemPrompt: "S", tools, messages: [user, reply(undefined), instruction] });
	assert.deepEqual(unsigned.input.map(({ id, ...item }) => item), expected.input.map(({ id, ...item }) => item));
	assert.deepEqual(unsigned.input.map((item) => item.id).filter(Boolean), ["msg_pi_0_tail"]);
});

// ---------------------------------------------------------------------------
// Hook wiring that a real session cannot easily drive

function harness() {
	const handlers = new Map();
	createCacheCompact({ now: () => clock })({ on: (name, handler) => handlers.set(name, handler), getThinkingLevel: () => "off" });
	const model = { provider: "p", id: "m", api: "anthropic-messages", reasoning: false, promptCache: { short: 300 } };
	let leaf = "u1";
	const sent = [];
	const ctx = {
		model,
		sessionManager: { getSessionId: () => "s", getLeafId: () => leaf },
		ui: { notify: () => {} },
		modelRegistry: { streamSimple: (_model, _context, options) => ({ result: async () => {
			sent.push(await options.onPayload({ messages: [{ role: "user", content: [{ type: "text", text: "sum" }] }] }));
			return { stopReason: "stop", content: [{ type: "text", text: "summary" }], usage: {} };
		} }) },
	};
	const entries = [{ type: "message", id: "u1", message: { role: "user", content: "q", timestamp: 1 } }];
	const compact = (overrides = {}) => handlers.get("session_before_compact")({
		reason: "manual", branchEntries: entries, signal: new AbortController().signal,
		preparation: { firstKeptEntryId: "u1", tokensBefore: 10, fileOps: { read: new Set(), edited: new Set(), written: new Set() } },
		...overrides,
	}, ctx);
	const request = (payload) => handlers.get("before_provider_request")({ payload }, ctx);
	return { ctx, sent, compact, request, setLeaf: (id) => { leaf = id; } };
}

test("warm replays refresh the capture's age without replacing it", async () => {
	const h = harness();
	h.request({ model: "m", messages: [{ role: "user", content: "q" }], max_tokens: 4096 });
	clock += 250_000;
	h.request({ model: "m", messages: [{ role: "user", content: "q" }], max_tokens: 1 });
	clock += 250_000;
	const result = await h.compact();
	assert.equal(result.compaction.summary, "summary");
	assert.equal(h.sent[0].max_tokens, 4096);
	assert.equal(h.sent[0].messages.length, 2);
	// A replay for a different leaf (new context) is not the captured request.
	h.setLeaf("other");
	h.request({ model: "m", messages: [], max_tokens: 1 });
	clock += 250_000;
	assert.equal(await h.compact(), undefined);
});

test("overflow, model switches and unsupported APIs use Pi's compaction", async () => {
	const h = harness();
	h.request({ model: "m", messages: [], max_tokens: 64 });
	assert.equal(await h.compact({ reason: "overflow" }), undefined);
	h.ctx.model = { ...h.ctx.model, id: "other" };
	assert.equal(await h.compact(), undefined);
	h.ctx.model = { ...h.ctx.model, id: "m", api: "openai-completions" };
	h.request({ model: "m", messages: [], max_tokens: 64 });
	assert.equal(await h.compact(), undefined);
	assert.equal(h.sent.length, 0);
});
