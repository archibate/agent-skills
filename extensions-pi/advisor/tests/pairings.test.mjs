import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const { parsePairings, readPolicy, resolveAdvisor } = await f.load("pairings.ts");
const { default: register } = await f.load("index.ts");
const main = { provider: "fixture", id: "cheap/model" };
const other = { provider: "fixture", id: "frontier" };
const pairings = { "fixture/cheap/model": "reviewer/strong/model", "fixture/frontier": null };
const source = JSON.stringify({ pairings });
const directory = () => mkdtempSync(join(f.scratch, "pairings-"));

test("exact pairings preserve slashes, explicit nulls, and absent models without fallback", () => {
	const policy = { pairings: parsePairings(source) };
	assert.equal(resolveAdvisor(policy, main), "reviewer/strong/model");
	for (const model of [other, undefined, { ...main, provider: "different" }, { ...main, id: "cheap" }]) {
		assert.equal(resolveAdvisor(policy, model), undefined);
	}
	assert.equal(resolveAdvisor({ pairings: parsePairings('{"pairings":{}}') }, main), undefined);
});

test("missing configuration stays absent; CLI override wins even over an unreadable config", () => {
	const path = join(directory(), "advisor.json");
	assert.equal(readPolicy(undefined, path).pairings.size, 0);
	assert.equal(existsSync(path), false);
	writeFileSync(path, "invalid JSON");
	assert.throws(() => readPolicy(undefined, path), /valid JSON/);
	for (const model of [main, other, undefined]) {
		assert.equal(resolveAdvisor(readPolicy("override/model", path), model), "override/model");
		assert.equal(resolveAdvisor(readPolicy("none", path), model), undefined);
	}
	for (const invalid of ["", "opus", " none", true, "provider/model extra"]) assert.throws(() => readPolicy(invalid, path));
});

test("configuration rejects malformed shapes, invalid IDs, and unexpected keys without echoing values", () => {
	for (const invalid of ["null", "[]", "{}", '{"pairs":{}}', '{"pairings":[],"secret":"secret"}', '{"pairings":{"main":null}}', '{"pairings":{"p/main":false}}', '{"pairings":{"p/main":"none"}}']) {
		assert.throws(() => parsePairings(invalid), (error) => !error.message.includes("secret"));
	}
	const path = join(directory(), "advisor.json");
	mkdirSync(path);
	assert.throws(() => readPolicy(undefined, path), /regular file/);
	const huge = join(directory(), "advisor.json");
	writeFileSync(huge, " ".repeat(1024 * 1024 + 1));
	assert.throws(() => readPolicy(undefined, huge), /1 MiB/);
});

function extension(override, content = source) {
	const agentDir = directory();
	const path = join(agentDir, "advisor.json");
	if (content !== undefined) writeFileSync(path, content);
	const handlers = new Map();
	let tool;
	let active = ["keep"];
	let registrations = 0;
	const api = {
		registerCommand() {}, registerFlag() {}, getFlag: (name) => name === "advisor" ? override : undefined,
		on: (name, handler) => handlers.set(name, handler),
		registerTool(value) { tool = value; if (++registrations > 1) active.push("manual-off"); },
		getActiveTools: () => [...active],
		setActiveTools: (names) => { active = names.filter((name) => name !== "advisor" || tool.exposure !== "hidden"); },
	};
	register(api, agentDir);
	return { path, handlers, api, get tool() { return tool; }, get active() { return active; } };
}

test("lifecycle follows main selection, preserves other tools, and guards stale disabled executions", async () => {
	const h = extension();
	const ctx = { model: main, sessionManager: { getEntries: () => [], getSessionId: () => "fixture" } };
	assert.equal(h.tool.exposure, "hidden");
	h.handlers.get("session_start")({}, ctx);
	assert.equal(h.tool.exposure, "model-only");
	assert.deepEqual(h.active, ["keep", "advisor"]);
	const stale = h.tool;
	h.handlers.get("model_select")({ model: other }, { model: main });
	assert.equal(h.tool.exposure, "hidden");
	assert.deepEqual(h.active, ["keep"]);
	await assert.rejects(stale.execute("late", {}, undefined, undefined, { model: other }), /disabled/);
	h.handlers.get("model_select")({ model: main });
	assert.deepEqual(h.active, ["keep", "advisor"]);
	h.api.setActiveTools(["keep"]); // A restored historical loadout omitted advisor.
	h.handlers.get("session_tree")({}, ctx);
	assert.deepEqual(h.active, ["keep", "advisor"]);
	h.handlers.get("session_shutdown")();
});

test("process-wide overrides stay fixed on model switches and before-agent fallback initializes safely", () => {
	for (const override of ["override/model", "none"]) {
		const h = extension(override, "not JSON");
		for (const model of [main, other, main]) {
			h.handlers.get("before_agent_start")({}, { model });
			assert.equal(h.tool.exposure, override === "none" ? "hidden" : "model-only");
		}
	}
});

test("main-model changes abort in-flight consultations even under a fixed CLI advisor override", async () => {
	const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
	const sdk = await import(`${f.host}/dist/index.js`);
	const h = extension("fixture/reviewer");
	const manager = sdk.SessionManager.inMemory(f.scratch);
	manager.appendMessage({ role: "user", content: "Synthetic evidence.", timestamp: 0 });
	const reviewer = { type: "chat", id: "reviewer", provider: "fixture", api: "openai-completions", reasoning: true, input: ["text"], maxTokens: 8192 };
	const usage = { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let signal;
	const ctx = { model: main, sessionManager: manager, getSystemPrompt: () => "Fixture.", modelRegistry: {
		find: () => reviewer, hasConfiguredAuth: () => true,
		streamSimple: (_model, _context, options) => {
			signal = options.signal;
			const stream = ai.createAssistantMessageEventStream();
			signal.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], api: reviewer.api, provider: reviewer.provider, model: reviewer.id, timestamp: 0, stopReason: "aborted", usage } });
				stream.end();
			}, { once: true });
			return stream;
		},
	} };
	h.handlers.get("session_start")({}, ctx);
	const pending = h.tool.execute("consult", {}, undefined, undefined, ctx);
	h.handlers.get("model_select")({ model: other });
	assert.equal(signal.aborted, true);
	const result = await pending;
	assert.equal(result.isError, true);
	assert.deepEqual(result.usage, usage);
	assert.equal(h.tool.exposure, "model-only", "The override remains enabled for future calls");
	h.handlers.get("session_shutdown")();
});

test("bad config withdraws advisor, reports once, and recovers only after session initialization/reload", async () => {
	const h = extension();
	const ctx = { model: main, sessionManager: { getEntries: () => [], getSessionId: () => "fixture" } };
	h.handlers.get("session_start")({}, ctx);
	writeFileSync(h.path, "invalid");
	assert.throws(() => h.handlers.get("session_start")({}, ctx), /configuration/);
	assert.equal(h.tool.exposure, "hidden");
	assert.deepEqual(h.active, ["keep"]);
	assert.doesNotThrow(() => h.handlers.get("before_agent_start")({}, ctx));
	await assert.rejects(h.tool.execute("late", {}, undefined, undefined, ctx), /configuration/);
	writeFileSync(h.path, source);
	h.handlers.get("before_agent_start")({}, ctx);
	assert.equal(h.tool.exposure, "hidden");
	h.handlers.get("session_start")({}, ctx);
	assert.equal(h.tool.exposure, "model-only");
});
