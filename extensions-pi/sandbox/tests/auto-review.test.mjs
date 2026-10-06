import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AutoReviewer, DEFAULT_REVIEWER_MODEL, REVIEW_LIMITS, parseAutoVerdict, reviewJson } from "../auto-review.ts";
import { createReviewer } from "../review.ts";
import { createReviewTools, readReviewFile } from "../review-tools.ts";

const model = { type: "chat", id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", name: "Luna", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const request = { toolCallId: "main-call", toolName: "bash", input: { command: "inspect", sandbox: { networkAccess: "full" } }, cwd: "/work", subject: "bash", excess: ['networkAccess "full"'], permissions: "read-only" };
const approve = { decision: "approve", reason: "Within the user's explicitly requested scope." };
const deny = { decision: "deny", reason: "Use the project-local cache instead." };
const paint = { fg: (_color, text) => text, bold: (text) => text };

function reply(value, extra = {}) {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], stopReason: "stop", usage, ...extra };
}

async function fixtureSandbox(request) {
	assert.deepEqual(request, { processAccess: "disable" });
	// These fixtures are private and static. Never use this identity wrapper in production.
	return { shell: (base) => base, env: (base) => base, dispose: async () => {} };
}

function fixture(t, plans = [approve]) {
	const cwd = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR, "auto-review-"));
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "user", content: "Inspect this project without deploying it.", timestamp: Date.now() });
	const calls = [];
	const selected = [];
	const records = [];
	let authenticated = true;
	const ctx = {
		cwd, mode: "print", signal: undefined, sessionManager: manager,
		getSystemPrompt: () => "Follow the user's scope and project instructions.",
		modelRegistry: {
			find(provider, id) { selected.push(`${provider}/${id}`); return model; },
			hasConfiguredAuth: () => authenticated,
			streamSimple(selectedModel, context, options) {
				calls.push({ model: selectedModel, context: structuredClone(context), options });
				const stream = createAssistantMessageEventStream();
				const plan = plans.shift();
				assert.notEqual(plan, undefined, "unexpected provider request");
				const finish = (message) => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: message.stopReason === "error" || message.stopReason === "aborted" ? "error" : "done", reason: message.stopReason, message, error: message });
					stream.end();
				};
				if (typeof plan === "function") plan({ finish, options, context });
				else queueMicrotask(() => finish(plan?.role === "assistant" ? plan : reply(plan)));
				return stream;
			},
		},
	};
	const reviewer = new AutoReviewer({ record: (record) => records.push(record), createTools: (cwd) => createReviewTools(cwd, fixtureSandbox) });
	t.after(() => { reviewer.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	return { ctx, cwd, manager, calls, selected, records, reviewer, noAuth: () => { authenticated = false; } };
}

const textOf = (message) => typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("");

test("strict verdict parser cannot approve malformed, ambiguous, or always responses", () => {
	assert.deepEqual(parseAutoVerdict(JSON.stringify(approve)), { kind: "approve", source: "auto", reason: approve.reason });
	assert.deepEqual(parseAutoVerdict(JSON.stringify(deny)), { kind: "deny", source: "auto", feedback: deny.reason });
	for (const bad of ["APPROVE", "```json\n{}\n```", "null", "[]", '{"decision":"approve"}', '{"decision":"always","reason":"ok"}', '{"decision":"approve","reason":"ok","always":true}', '{"decision":true,"reason":"ok"}', '{"decision":"deny","reason":"no","decision":"approve"}', '{"decision":"deny","reason":" "}', JSON.stringify({ ...approve, reason: "x".repeat(1201) })]) assert.throws(() => parseAutoVerdict(bad), undefined, bad);
	assert.equal(parseAutoVerdict('{"decision":"deny","reason":"\\u001b[31mNo\\u001b[0m\\nuse local files"}').feedback, "No use local files");
	assert.throws(() => reviewJson({ huge: "x".repeat(200) }, 100), /context budget/);
	assert.throws(() => reviewJson({ many: Array(20001).fill(0) }, 1000000), /context budget/);
});

test("Luna is lazy, receives exact quoted evidence, and reuses its own prefix with main deltas", async (t) => {
	const { ctx, manager, calls, records, selected, reviewer } = fixture(t, [approve, deny]);
	assert.equal(calls.length, 0);
	manager.appendMessage(reply("proposing a main action", { content: [{ type: "toolCall", id: "unresolved-main", name: "write", arguments: { path: "x", content: "x" } }], stopReason: "toolUse" }));
	assert.equal((await reviewer.review(request, ctx)).kind, "approve");
	assert.equal(selected[0], DEFAULT_REVIEWER_MODEL);
	assert.equal(calls[0].options.reasoning, "low");
	assert.equal(calls[0].options.maxTokens, 2048);
	assert.ok(calls[0].options.sessionId.includes(".sandbox-review."));
	const first = calls[0].context.messages;
	const quoted = JSON.parse(textOf(first.at(-1)));
	assert.deepEqual(quoted.proposal, request);
	assert.equal(quoted.mainDelta.at(-1).content[0].id, "unresolved-main");
	assert.ok(!first.some((m) => m.role === "assistant"), "main tool calls are data, never live side calls");
	manager.appendMessage({ role: "user", content: "Keep the next action local.", timestamp: Date.now() });
	assert.equal((await reviewer.review(request, ctx)).kind, "deny");
	const second = calls[1].context.messages;
	assert.deepEqual(second.slice(0, first.length), first, "reviewer prefix is unchanged");
	const delta = JSON.parse(textOf(second.at(-1)));
	assert.equal(delta.projectInstructions, undefined);
	assert.equal(delta.mainDelta.length, 1);
	assert.equal(delta.mainDelta[0].content, "Keep the next action local.");
	assert.equal(calls[1].options.sessionId, calls[0].options.sessionId);
	assert.deepEqual(records.map((r) => r.decision), ["approve", "deny"]);
	assert.equal(records[0].usage.input, 10);
	assert.equal(records[0].usage.cacheRead, 3);
	assert.equal(records[0].usage.cacheWrite, 0);
});

test("branch rewind and project-instruction changes rebuild rather than reuse stale evidence", async (t) => {
	const { ctx, manager, calls, reviewer } = fixture(t, [approve, approve, approve]);
	await reviewer.review(request, ctx);
	manager.resetLeaf();
	manager.appendMessage({ role: "user", content: "New branch with different intent.", timestamp: Date.now() });
	await reviewer.review(request, ctx);
	assert.notEqual(calls[1].options.sessionId, calls[0].options.sessionId);
	assert.equal(JSON.parse(textOf(calls[1].context.messages.at(-1))).mainDelta[0].content, "New branch with different intent.");
	ctx.getSystemPrompt = () => "Changed project instructions.";
	await reviewer.review(request, ctx);
	assert.notEqual(calls[2].options.sessionId, calls[1].options.sessionId);
});

test("cleanup failure does not derail invalidation or launch another automatic request", async (t) => {
	const { ctx, calls, reviewer } = fixture(t);
	await reviewer.review(request, ctx);
	const unregister = registerSessionResourceCleanup((id) => {
		if (id?.includes(".sandbox-review.")) throw new Error("simulated cleanup failure");
	});
	t.after(unregister);
	assert.doesNotThrow(() => reviewer.reset());
	const verdict = await reviewer.review(request, ctx);
	assert.equal(verdict.kind, "deny");
	assert.match(verdict.feedback, /cleanup failed/);
	assert.equal(calls.length, 1);
});

test("investigation executes only bounded read-only queries, then continues to a verdict", async (t) => {
	const { ctx, cwd, calls, reviewer } = fixture(t, [reply("", { content: [{ type: "toolCall", id: "inspect", name: "read", arguments: { path: "intent.txt" } }], stopReason: "toolUse" }), approve]);
	writeFileSync(join(cwd, "intent.txt"), "Project-local evidence.");
	assert.equal((await reviewer.review(request, ctx)).kind, "approve");
	const result = calls[1].context.messages.find((m) => m.role === "toolResult");
	assert.match(textOf(result), /Project-local evidence/);
});

test("failed investigation cannot be ignored in favor of a later approval", async (t) => {
	const { ctx, calls, reviewer } = fixture(t, [reply("", { content: [{ type: "toolCall", id: "missing", name: "read", arguments: { path: "missing.txt" } }], stopReason: "toolUse" }), approve]);
	const verdict = await reviewer.review(request, ctx);
	assert.equal(verdict.kind, "deny");
	assert.equal(calls.length, 1);
});

test("search preparation failures and wrapper stderr cannot masquerade as no matches", async (t) => {
	const { cwd } = fixture(t);
	const broken = Object.fromEntries(createReviewTools(cwd, async () => { throw new Error("sandbox unavailable"); }).map((tool) => [tool.name, tool]));
	await assert.rejects(broken.grep.execute("q", { pattern: "needle", path: cwd }), /sandbox unavailable/);
	let disposed = 0;
	const badWrapper = async (request) => {
		assert.deepEqual(request, { processAccess: "disable" });
		return { shell: () => ({ shell: process.execPath, args: ["-e", 'process.stderr.write("sandbox setup failed"); process.exit(1)'] }), env: (base) => base, dispose: async () => { disposed++; } };
	};
	const tools = Object.fromEntries(createReviewTools(cwd, badWrapper).map((tool) => [tool.name, tool]));
	await assert.rejects(tools.grep.execute("q", { pattern: "needle", path: cwd }), /sandbox setup failed/);
	assert.equal(disposed, 1);
});

test("a mutating tool attempt blocks the reviewer without executing or making another request", async (t) => {
	const { ctx, cwd, calls, reviewer } = fixture(t, [reply("", { content: [{ type: "toolCall", id: "mutate", name: "write", arguments: { path: "planted", content: "bad" } }], stopReason: "toolUse" })]);
	const verdict = await reviewer.review(request, ctx);
	assert.equal(verdict.kind, "deny");
	assert.equal(existsSync(join(cwd, "planted")), false);
	assert.equal(calls.length, 1);
});

test("authentication, provider errors, truncated output and malformed verdicts fail closed", async (t) => {
	for (const plan of ["garbage", reply("", { stopReason: "error", errorMessage: "offline" }), reply(JSON.stringify(approve), { stopReason: "length" })]) {
		const { ctx, reviewer } = fixture(t, [plan]);
		assert.equal((await reviewer.review(request, ctx)).kind, "deny");
	}
	const { ctx, calls, noAuth, reviewer } = fixture(t);
	noAuth();
	assert.equal((await reviewer.review(request, ctx)).kind, "deny");
	assert.equal(calls.length, 0);
});

test("context and request budgets stop requests before the provider", async (t) => {
	const { ctx, calls, reviewer } = fixture(t);
	assert.equal((await reviewer.review({ ...request, input: { content: "x".repeat(REVIEW_LIMITS.contextBytes + 1) } }, ctx)).kind, "deny");
	assert.equal(calls.length, 0);
	const zero = new AutoReviewer({ limits: { requests: 0 } });
	t.after(() => zero.dispose());
	assert.equal((await zero.review(request, ctx)).kind, "deny");
	assert.equal(calls.length, 0);
});

test("timeouts and cancellation discard late approvals and prevent overlapping requests", async (t) => {
	let finish;
	const { ctx, calls, reviewer } = fixture(t, [({ finish: f }) => { finish = f; }]);
	const controller = new AbortController();
	ctx.signal = controller.signal;
	const pending = reviewer.review(request, ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	assert.equal((await pending).cancelled, true);
	ctx.signal = undefined;
	assert.equal((await reviewer.review(request, ctx)).kind, "deny");
	assert.equal(calls.length, 1, "an uncooperative previous request blocks new ones");
	finish(reply(approve));
	await new Promise((resolve) => setTimeout(resolve, 5));
	const timed = new AutoReviewer({ limits: { timeoutMs: 5 } });
	t.after(() => timed.dispose());
	let late;
	const old = ctx.modelRegistry.streamSimple;
	ctx.modelRegistry.streamSimple = (_model, _context, _options) => {
		const stream = createAssistantMessageEventStream();
		late = () => { const message = reply(approve); stream.push({ type: "done", reason: "stop", message }); stream.end(); };
		return stream;
	};
	const result = await timed.review(request, ctx);
	assert.equal(result.kind, "deny");
	assert.notEqual(result.cancelled, true, "timeout can escalate to human; cancellation cannot");
	late();
	ctx.modelRegistry.streamSimple = old;
});

test("auto-manual escalates only denials/failures and identifies human decisions", async (t) => {
	const { ctx } = fixture(t, [approve, deny, "bad verdict"]);
	ctx.mode = "tui";
	const frames = [];
	ctx.ui = {
		custom: (factory) => new Promise((resolve) => {
			const modal = factory({ requestRender() {} }, paint, {}, resolve);
			frames.push(modal.render(80).join("\n"));
			setTimeout(() => modal.handleInput("y"), 320);
		}),
	};
	const hybrid = createReviewer("auto-manual", "tui");
	t.after(() => hybrid.dispose());
	assert.equal((await hybrid.review(request, ctx)).source, "auto");
	assert.equal(frames.length, 0);
	assert.equal((await hybrid.review(request, ctx)).source, "manual");
	assert.match(frames[0], /Automatic review:[\s\S]*project-local cache/);
	assert.equal((await hybrid.review(request, ctx)).source, "manual");
	assert.match(frames[1], /Automatic review unavailable/);
	assert.throws(() => createReviewer("auto-manual", "print"), /needs the interactive TUI/);
});

for (const action of ["reset", "dispose"]) {
	test(`hybrid ${action} cancels an active manual escalation without accepting a late answer`, { timeout: 1000 }, async (t) => {
		const { ctx, calls } = fixture(t, [deny, approve]);
		ctx.mode = "tui";
		let ready;
		let answer;
		let frames = 0;
		const opened = new Promise((resolve) => { ready = resolve; });
		ctx.ui = {
			custom: (factory) => new Promise((resolve) => {
				answer = resolve;
				factory({ requestRender() {} }, paint, {}, resolve);
				frames++;
				ready();
			}),
		};
		const hybrid = createReviewer("auto-manual", "tui");
		t.after(() => hybrid.dispose());
		const pending = hybrid.review(request, ctx);
		await opened;
		hybrid[action]();
		const verdict = await pending;
		assert.equal(verdict.kind, "deny");
		assert.equal(verdict.cancelled, true);
		answer({ kind: "approve" });
		const next = await hybrid.review(request, ctx);
		assert.equal(next.kind, action === "reset" ? "approve" : "deny");
		assert.equal(calls.length, action === "reset" ? 2 : 1);
		assert.equal(frames, 1);
	});
}

test("hybrid does not escalate or invent usage when recording the automatic verdict fails", async (t) => {
	const { ctx, calls } = fixture(t, [approve]);
	ctx.mode = "tui";
	ctx.ui = { custom: () => { throw new Error("must not escalate an unaudited verdict"); } };
	const records = [];
	const hybrid = createReviewer("auto-manual", "tui", {
		record: (record) => { records.push(record); throw new Error("secret storage detail"); },
	});
	t.after(() => hybrid.dispose());
	const verdict = await hybrid.review(request, ctx);
	assert.equal(verdict.kind, "deny");
	assert.equal(verdict.cancelled, true);
	assert.match(verdict.feedback, /audit could not be recorded/);
	assert.doesNotMatch(verdict.feedback, /secret/);
	assert.equal(calls.length, 1);
	assert.equal(records.length, 1, "do not retry recording with invented zero usage");
	assert.equal(records[0].usage.input, 10);
});

test("review tools handle private fixtures and ignore rg config or argv-like glob values", async (t) => {
	const { cwd } = fixture(t);
	mkdirSync(join(cwd, "sub"));
	writeFileSync(join(cwd, "intent.txt"), "needle\nsecond line\n");
	writeFileSync(join(cwd, "rg-config"), "--pre=/nonexistent/should-not-run\n");
	const saved = process.env.RIPGREP_CONFIG_PATH;
	process.env.RIPGREP_CONFIG_PATH = join(cwd, "rg-config");
	t.after(() => { if (saved === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = saved; });
	const tools = Object.fromEntries(createReviewTools(cwd, fixtureSandbox).map((tool) => [tool.name, tool]));
	const run = async (name, args) => (await tools[name].execute("q", args)).content.map((b) => b.text).join("\n");
	assert.match(await run("read", { path: "intent.txt", limit: 1 }), /needle/);
	assert.match(await run("grep", { pattern: "needle", path: cwd }), /intent.txt:1:needle/);
	assert.match(await run("find", { pattern: "*.txt" }), /intent.txt/);
	assert.match(await run("ls", { path: cwd }), /sub\//);
	assert.match(await run("ls", { path: cwd, limit: 1 }), /Listing truncated/);
	await run("grep", { pattern: "needle", glob: "--pre=/nonexistent/should-not-run" });
	writeFileSync(join(cwd, "big"), "");
	truncateSync(join(cwd, "big"), 5 * 1024 * 1024);
	await assert.rejects(readReviewFile(join(cwd, "big")), /at most 4 MiB/);
	await assert.rejects(readReviewFile(cwd), /regular file/);
	writeFileSync(join(cwd, "binary"), Buffer.from([0, 1]));
	await assert.rejects(readReviewFile(join(cwd, "binary")), /Binary\/image/);
	await assert.rejects(readReviewFile("/dev/zero"), /exclude device/);
});
