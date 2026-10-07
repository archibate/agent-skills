import assert from "node:assert/strict";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const { buildTranscript } = await f.load("transcript.ts");
const { TranscriptCache } = await f.load("cache.ts");
const { readConfig } = await f.load("config.ts");
const { Advisor, REVIEWER_PROMPT } = await f.load("advisor.ts");
const { default: register } = await f.load("index.ts");
const sdk = await import(`${f.host}/dist/index.js`);
const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
const { anthropicMessagesApi } = await import(`${f.host}/../pi-ai/dist/compat.js`);

const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 30, totalTokens: 65, cost: { input: .01, output: .01, cacheRead: .01, cacheWrite: .01, total: .04 } };
const assistant = (content, rest = {}) => ({ role: "assistant", content, api: "anthropic-messages", provider: "test", model: "advisor", timestamp: 0, stopReason: "stop", usage, ...rest });
const user = (content) => ({ role: "user", content, timestamp: 0 });
const result = (toolName, toolCallId, content) => ({ role: "toolResult", toolName, toolCallId, content, isError: false, timestamp: 0 });
const text = (text) => ({ type: "text", text });
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const joined = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");

function harness(response = assistant([text("Looks sound.")])) {
	const manager = sdk.SessionManager.inMemory(f.scratch);
	manager.appendMessage(user("Please review this change."));
	const requests = [];
	const model = { type: "chat", id: "advisor", name: "Test", provider: "test", api: "anthropic-messages", baseUrl: "https://invalid.test", contextWindow: 200_000, maxTokens: 32_000, reasoning: true, input: ["text", "image"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
	const ctx = {
		sessionManager: manager, getSystemPrompt: () => "User-approved scope only.",
		modelRegistry: {
			find: () => model, hasConfiguredAuth: () => true,
			streamSimple: (selected, context, options) => {
				requests.push({ selected, context, options });
				const pending = typeof response === "function" ? response(options) : Promise.resolve(response);
				return {
					result: () => pending,
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: assistant([], { stopReason: "pending", usage: structuredClone(usage) }) };
						const message = await pending;
						yield message.stopReason === "error" || message.stopReason === "aborted" ? { type: "error", error: message } : { type: "done", message };
					},
				};
			},
		},
	};
	return { manager, ctx, requests, model };
}
const config = readConfig(() => undefined, "test/advisor");

test("compact labeled transcript preserves visible evidence but excludes protocol metadata and reasoning", () => {
	const messages = [
		user("Can I change X?"), assistant([text("Yes; go?"), { type: "thinking", thinking: "PRIVATE", thinkingSignature: "SECRET" }]),
		user("go"), assistant([call("internal-uuid", "read", { path: "x.ts" })]), result("read", "internal-uuid", [text("actual file")]),
		assistant([call("advisor-uuid", "advisor")]), result("advisor", "advisor-uuid", [text("old advice")]),
		user("Correction: only Y."), { role: "system", content: "STALE INSTRUCTION", timestamp: 0 },
	];
	const before = structuredClone(messages);
	const blocks = buildTranscript(messages, "CURRENT INSTRUCTION");
	assert.equal(blocks.length, 9);
	const transcript = joined(blocks);
	assert.match(transcript, /Can I change X\?[\s\S]*Yes; go\?[\s\S]*\[User\]\ngo/);
	assert.match(transcript, /Tool call #1: read[\s\S]*Tool result: read #1/);
	assert.match(transcript, /Prior advisor result #2[\s\S]*old advice[\s\S]*Correction: only Y/);
	assert.doesNotMatch(transcript, /PRIVATE|SECRET|internal-uuid|advisor-uuid|STALE INSTRUCTION|usage|timestamp/);
	assert.deepEqual(messages, before);
	assert.deepEqual(buildTranscript([...messages, user("new")], "CURRENT INSTRUCTION").slice(0, blocks.length), blocks);
});

test("native image blocks keep their chronological position and strip opaque metadata", () => {
	const blocks = buildTranscript([user([text("before"), { ...image, extra: "SECRET" }, text("after")]), result("read", "img", [image])], "rules");
	assert.deepEqual(blocks, [text("[Main agent instructions — current]\nrules"), text("[User]\nbefore"), image, text("after"), text("[Tool result: read #1]\n"), image]);
	assert.doesNotMatch(joined(blocks), /aW1hZ2U|SECRET/);
	assert.throws(() => buildTranscript([user([{ ...image, data: "" }])], ""), /unavailable/);
});

test("summaries, custom messages, and user shell executions have explicit provenance", () => {
	const blocks = buildTranscript([
		{ role: "compactionSummary", summary: "Earlier intent" }, { role: "branchSummary", summary: "Other branch" },
		{ role: "custom", customType: "notice", content: "constraint", details: "SECRET" },
		{ role: "bashExecution", command: "ls", output: "files", exitCode: 0, truncated: true, fullOutputPath: "output.log" },
		{ role: "bashExecution", command: "SECRET", output: "SECRET", excludeFromContext: true },
	], "rules");
	assert.match(joined(blocks), /Compaction summary — not original evidence/);
	assert.match(joined(blocks), /Branch summary — not original evidence/);
	assert.match(joined(blocks), /Context: notice/);
	assert.match(joined(blocks), /output truncated[\s\S]*output.log/);
	assert.doesNotMatch(joined(blocks), /SECRET/);
});

test("oversized and unknown content fails explicitly rather than dropping evidence", () => {
	assert.throws(() => buildTranscript([user("x".repeat(100))], "", 80), /Nothing was silently truncated/);
	assert.throws(() => buildTranscript([{ role: "alien", content: "private" }], ""), /cannot serialize/);
});

const wire = (count, overrides = {}) => ({ model: "opus", max_tokens: 8192, system: [text("Reviewer")], messages: [{ role: "user", content: Array.from({ length: count }, (_, i) => text(`Message ${i}`)) }], ...overrides });
const marked = (payload) => payload.messages[0].content.flatMap((b, i) => b.cache_control ? [i] : []);

test("cache markers reuse an old endpoint beyond Anthropic's 20-block lookback", () => {
	const cache = new TranscriptCache();
	const first = wire(3);
	cache.prepare(first, "session", "short")();
	assert.deepEqual(marked(first), [2]);
	const second = wire(30);
	cache.prepare(second, "session", "short")();
	assert.deepEqual(marked(second), [2, 29]);
	assert.equal(second.system[0].cache_control.type, "ephemeral");
	const third = wire(31);
	cache.prepare(third, "session", "short")();
	assert.deepEqual(marked(third), [29, 30]);
});

test("cache epoch changes, edited content, images, model settings, and uncommitted requests", () => {
	for (const change of [
		(p) => { p.messages[0].content[0].text = "compacted"; },
		(p) => { p.system[0].text = "new instructions"; },
		(p) => { p.thinking = { type: "adaptive" }; },
		(p) => { p.messages[0].content[1] = { type: "image", source: { data: "different" } }; },
	]) {
		const cache = new TranscriptCache();
		cache.prepare(wire(3), "one", "short")();
		const next = wire(6); change(next);
		cache.prepare(next, "one", "short")();
		assert.deepEqual(marked(next), [5]);
	}
	const cache = new TranscriptCache();
	cache.prepare(wire(3), "one", "short"); // Failed before a confirmed response.
	const fresh = wire(6); cache.prepare(fresh, "one", "short")();
	assert.deepEqual(marked(fresh), [5]);
	const switched = wire(9); cache.prepare(switched, "other-session", "short")();
	assert.deepEqual(marked(switched), [8]);
	cache.reset();
	const reset = wire(10); cache.prepare(reset, "other-session", "short")();
	assert.deepEqual(marked(reset), [9]);
});

test("cache disabled removes markers; long cache asks for 1h; bad payloads fail closed", () => {
	const cache = new TranscriptCache();
	const p = wire(3); cache.prepare(p, "one", "long")();
	assert.equal(p.messages[0].content[2].cache_control.ttl, "1h");
	cache.prepare(p, "one", "none")();
	assert.deepEqual(marked(p), []);
	assert.equal(p.system[0].cache_control, undefined);
	assert.throws(() => cache.prepare({ messages: [] }, "one", "short"), /one multimodal/);
});

test("configuration validates route, supported level names, ceilings, TTL, and deadline", () => {
	assert.equal(readConfig(() => undefined, "test/advisor").thinking, "high");
	assert.equal(config.maxTokens, undefined);
	assert.equal(config.timeoutMs, 180_000);
	assert.equal(readConfig((name) => name === "advisor-max-tokens" ? "4096" : undefined, "test/advisor").maxTokens, 4096);
	for (const [key, value] of [["advisor-thinking", "extreme"], ["advisor-cache", "forever"], ["advisor-max-tokens", "Infinity"], ["advisor-timeout", "0"]]) {
		assert.throws(() => readConfig((name) => name === key ? value : undefined, "test/advisor"));
	}
	assert.throws(() => readConfig(() => undefined, "opus"));
	assert.equal(readConfig(() => undefined, "ofox/anthropic/claude-opus-5.5").model, "ofox/anthropic/claude-opus-5.5");
});

test("consultation uses one user message, separate system, no tools; usage and advice return without thinking", async () => {
	const h = harness(assistant([{ type: "thinking", thinking: "PRIVATE" }, text("Read cancellation handling.")]));
	const advisor = new Advisor();
	const out = await advisor.consult(h.ctx, config);
	assert.equal(out.isError, undefined);
	assert.equal(h.requests.length, 1);
	const { selected, context, options } = h.requests[0];
	assert.equal(context.systemPrompt, REVIEWER_PROMPT);
	assert.equal(context.messages.length, 1);
	assert.equal(context.messages[0].role, "user");
	assert.equal(context.tools, undefined);
	assert.equal(options.maxRetries, 0);
	assert.equal(selected.maxTokens, h.model.maxTokens);
	assert.equal(options.maxTokens, h.model.maxTokens);
	assert.equal(h.model.maxTokens, 32_000);
	assert.deepEqual(out.usage, usage);
	assert.match(joined(out.content), /20 cache read[\s\S]*Read cancellation/);
	assert.doesNotMatch(joined(out.content), /PRIVATE/);
	advisor.dispose();
});

test("explicit output caps reach inference without raising the model's own limit", async () => {
	for (const [maxTokens, expected] of [[4096, 4096], [65536, 32000]]) {
		const h = harness();
		const advisor = new Advisor();
		try {
			const out = await advisor.consult(h.ctx, { ...config, maxTokens });
			assert.equal(out.isError, undefined);
			assert.equal(h.requests[0].selected.maxTokens, expected);
			assert.equal(h.requests[0].options.maxTokens, expected);
			assert.equal(h.model.maxTokens, 32000);
		} finally { advisor.dispose(); }
	}
});

test("effective compaction and branch selection never resurrect raw history", async () => {
	const h = harness();
	const old = h.manager.appendMessage(user("OLD SECRET"));
	const kept = h.manager.appendMessage(user("keep this"));
	h.manager.appendCompaction("SUMMARY", kept, 1000);
	h.manager.appendMessage(user("after compact"));
	const advisor = new Advisor();
	await advisor.consult(h.ctx, config);
	const transcript = joined(h.requests[0].context.messages[0].content);
	assert.match(transcript, /Compaction summary[\s\S]*SUMMARY[\s\S]*keep this[\s\S]*after compact/);
	assert.doesNotMatch(transcript, /OLD SECRET|Please review/);
	h.manager.branch(old);
	h.manager.appendMessage(user("OTHER BRANCH"));
	await advisor.consult(h.ctx, config);
	const branch = joined(h.requests[1].context.messages[0].content);
	assert.match(branch, /OTHER BRANCH/);
	assert.doesNotMatch(branch, /SUMMARY|after compact|keep this/);
	advisor.dispose();
});

test("context-edit replacements, omissions, and branch-relative restoration reach the advisor", async () => {
	const h = harness();
	const first = h.manager.appendMessage(user("ORIGINAL"));
	const second = h.manager.appendMessage(user("OMIT ME"));
	h.manager.appendContextEdit(first, { content: "REPLACED" });
	h.manager.appendContextEdit(second, null);
	const advisor = new Advisor();
	await advisor.consult(h.ctx, config);
	const current = joined(h.requests[0].context.messages[0].content);
	assert.match(current, /REPLACED/);
	assert.doesNotMatch(current, /ORIGINAL|OMIT ME/);
	h.manager.branch(second);
	await advisor.consult(h.ctx, config);
	const restored = joined(h.requests[1].context.messages[0].content);
	assert.match(restored, /ORIGINAL[\s\S]*OMIT ME/);
	assert.doesNotMatch(restored, /REPLACED/);
	advisor.dispose();
});

test("second consult includes prior advisor calls as quoted tool history, never native assistant", async () => {
	const h = harness();
	const advisor = new Advisor();
	h.manager.appendMessage(assistant([call("a1", "advisor")]));
	const first = await advisor.consult(h.ctx, config);
	h.manager.appendMessage(result("advisor", "a1", first.content));
	h.manager.appendMessage(assistant([text("I gathered more evidence."), call("a2", "advisor")]));
	await advisor.consult(h.ctx, config);
	const messages = h.requests[1].context.messages;
	assert.deepEqual(messages.map((m) => m.role), ["user"]);
	assert.match(joined(messages[0].content), /Prior advisor result #1[\s\S]*Looks sound[\s\S]*more evidence/);
	advisor.dispose();
});

test("model, auth, effort, and image incompatibility fail before inference without fallback", async () => {
	for (const mutate of [
		(h) => { h.ctx.modelRegistry.find = () => undefined; },
		(h) => { h.ctx.modelRegistry.hasConfiguredAuth = () => false; },
		(h) => { h.model.reasoning = false; },
		(h) => { h.model.api = "pi-virtual"; },
		(h) => { h.model.input = ["text"]; h.manager.appendMessage(user([image])); },
	]) {
		const h = harness(); mutate(h);
		const advisor = new Advisor();
		assert.equal((await advisor.consult(h.ctx, config)).isError, true);
		assert.equal(h.requests.length, 0);
		advisor.dispose();
	}
});

test("error, aborted, empty, tool-call, and truncated responses are not mistaken for complete reviews", async () => {
	for (const response of [assistant([], { stopReason: "error", errorMessage: "provider unavailable" }), assistant([], { stopReason: "aborted" }), assistant([]), assistant([call("bad", "bash")])]) {
		const h = harness(response);
		const advisor = new Advisor();
		const out = await advisor.consult(h.ctx, config);
		assert.equal(out.isError, true);
		assert.deepEqual(out.usage, usage);
		advisor.dispose();
	}
	const h = harness(assistant([text("Partial advice")], { stopReason: "length" }));
	const advisor = new Advisor();
	assert.match(joined((await advisor.consult(h.ctx, config)).content), /review is incomplete/);
	advisor.dispose();
});

test("timeout and concurrent requests stay bounded even if the provider ignores cancellation", async () => {
	let resolve;
	const h = harness(() => new Promise((done) => { resolve = done; }));
	const advisor = new Advisor();
	const first = advisor.consult(h.ctx, { ...config, timeoutMs: 15 });
	const second = await advisor.consult(h.ctx, config);
	assert.equal(second.isError, true);
	assert.match(joined(second.content), /still running/);
	const timed = await first;
	assert.match(joined(timed.content), /deadline/);
	assert.equal(timed.details.usageStatus, "partial");
	assert.deepEqual(timed.usage, usage);
	assert.match(joined(timed.content), /may be incomplete/);
	assert.equal(h.requests[0].options.signal.aborted, true);
	assert.equal((await advisor.consult(h.ctx, config)).isError, true);
	resolve(assistant([text("Late result")]));
	await new Promise((done) => setImmediate(done));
	advisor.dispose();
});

test("cancellation, reset, and disposal abort owned calls and prevent late cache commits", async () => {
	for (const action of ["cancel", "reset", "dispose"]) {
		const h = harness((options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(assistant([], { stopReason: "aborted" })), { once: true })));
		const advisor = new Advisor();
		const abort = new AbortController();
		const pending = advisor.consult(h.ctx, config, abort.signal);
		if (action === "cancel") abort.abort(); else advisor[action]();
		assert.equal((await pending).isError, true);
		assert.equal(h.requests[0].options.signal.aborted, true);
		advisor.dispose();
	}
});

test("cancelled calls preserve terminal usage and never commit their cache candidate", async () => {
	let calls = 0;
	let secondMarkers;
	const h = harness((options) => {
		const payload = wire(++calls === 1 ? 3 : 6);
		options.onPayload(payload);
		if (calls === 2) { secondMarkers = marked(payload); return Promise.resolve(assistant([text("Completed")])); }
		return new Promise((resolve) => options.signal.addEventListener("abort", () => setTimeout(() => resolve(assistant([], { stopReason: "aborted", usage: { ...usage, totalTokens: 113 } })), 10), { once: true }));
	});
	const advisor = new Advisor();
	const first = await advisor.consult(h.ctx, { ...config, timeoutMs: 10 });
	assert.equal(first.isError, true);
	assert.equal(first.usage.totalTokens, 113);
	assert.equal(first.details.usageStatus, "reported");
	assert.equal((await advisor.consult(h.ctx, config)).isError, undefined);
	assert.deepEqual(secondMarkers, [5], "A cancelled response must not advance the cache endpoint");
	advisor.dispose();
});

test("extension factory is inert; tool has no arguments, is sequential, and starts hidden", () => {
	const flags = [];
	const handlers = new Map();
	let tool;
	register({ registerCommand() {}, registerFlag: (name) => flags.push(name), on: (name, handler) => handlers.set(name, handler), registerTool: (value) => { tool = value; } });
	assert.equal(flags.length, 5);
	assert.equal(tool.name, "advisor");
	assert.deepEqual(tool.parameters.properties, {});
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.exposure, "hidden");
	assert.equal(tool.defaultActive, false);
	assert.ok(flags.includes("advisor"));
	assert.ok(!flags.includes("advisor-model"));
	handlers.get("session_shutdown")();
});

test("real Anthropic adapter preserves every block/image, emits no tools, and respects old/new cache endpoints", async () => {
	const model = { ...harness().model, compat: { forceAdaptiveThinking: true } };
	const provider = ai.createProvider({ id: "test", name: "Test", auth: {}, models: [model], api: { "anthropic-messages": anthropicMessagesApi() } });
	const cache = new TranscriptCache();
	let commit;
	let captured;
	const contents = [text("[User]\nfirst"), image];
	for (let round = 0; round < 2; round++) {
		const context = ai.normalizeContext({ systemPrompt: REVIEWER_PROMPT, messages: [{ role: "user", content: [...contents], timestamp: 0 }] });
		await provider.streamSimple(model, context, { apiKey: "unit-test-key", reasoning: "high", maxTokens: 8192, onPayload: (payload) => {
			commit = cache.prepare(payload, "session", "short"); captured = payload; throw new Error("Stop before HTTP");
		} }).result();
		assert.equal(captured.messages.length, 1);
		assert.equal(captured.messages[0].content.length, contents.length);
		assert.deepEqual(captured.messages[0].content[1].source, { type: "base64", media_type: image.mimeType, data: image.data });
		assert.equal(captured.tools, undefined);
		assert.deepEqual(marked(captured), round === 0 ? [1] : [1, 26]);
		commit();
		contents.push(...Array.from({ length: 25 }, (_, i) => text(`Next ${i}`)));
	}
});
