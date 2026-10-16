// Run: node --test tests/koozhan_provider_test.mjs   (resolves Pi from the managed install)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const agent = join(homedir(), ".pi/agent/install");
const version = readFileSync(join(agent, "current-version"), "utf8").trim();
const parentURL = pathToFileURL(join(agent, "releases", version, "node_modules", "_.mjs")).href;
registerHooks({
	resolve(specifier, context, next) {
		return next(specifier, specifier.startsWith("@earendil-works/") ? { ...context, parentURL } : context);
	},
});
const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/compat");
const { anthropicErrorTypes, koozhanAnthropic, normalizeCatalog } = await import("../provider.ts");

const GRAMMAR = "The compiled grammar is too large, which would cause performance issues.";
const nilError = () => new Response(JSON.stringify({ error: { type: "<nil>", message: GRAMMAR }, type: "error" }), {
	status: 400, headers: { "content-type": "application/json", "request-id": "req_1" },
});
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
	status: 200, headers: { "content-type": "text/event-stream" },
});
const reply = () => sse([
	{ type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]);

test("rewrites only Koozhan's <nil> 400 error type", async () => {
	const body = await (await anthropicErrorTypes(async () => nilError())("https://x")).json();
	assert.equal(body.error.type, "invalid_request_error");
	assert.equal(body.error.message, GRAMMAR);
	const typed = new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 400 });
	assert.equal(await anthropicErrorTypes(async () => typed)("https://x"), typed);
	const ok = reply();
	assert.equal(await anthropicErrorTypes(async () => ok)("https://x"), ok);
});

test("grammar-too-large falls back to non-strict tools", async () => {
	const [model] = normalizeCatalog({ models: [{
		id: "claude-opus-5-5", chat_selectable: true, status: "available", max_tokens: 1_000_000,
		pricing: { input_usd_per_1m_tokens: 1, output_usd_per_1m_tokens: 5 },
	}] });
	assert.equal(model.compat?.supportsStrictTools, true);
	const bodies = [];
	const fetcher = async (_url, init) => {
		bodies.push(JSON.parse(init.body));
		return bodies.length === 1 ? nilError() : reply();
	};
	const tool = {
		name: "read", description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
	// Pi 1.3 declares tools on the leading system message, not on `context.tools`.
	const context = { messages: [
		{ role: "system", content: "test", toolsAdded: [tool], timestamp: 0 },
		{ role: "user", content: "hi", timestamp: 0 },
	] };
	const result = await koozhanAnthropic(anthropicMessagesApi())
		.stream(model, context, { apiKey: "test-key", fetch: fetcher, maxRetries: 0 }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0].tools[0].strict, true);
	assert.equal(bodies[1].tools[0].strict, undefined);
});
