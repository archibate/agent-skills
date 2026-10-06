import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { parsePermissions } from "../permissions.ts";

// Offline: loads the real pi runtime with the sandbox extension and drives tool_call review. The
// manual reviewer gets a fake UI that answers the modal; no terminal, model, or network is used.
const sdkPath = process.env.PI_SDK_PATH;
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };

async function waitForReview(calls) {
	for (let i = 0; i < 1000 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.notEqual(calls.length, 0, "reviewer did not start");
}

async function setup(t) {
	const sdk = await import(pathToFileURL(sdkPath).href);
	const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-review-"));
	const cwd = join(base, "project");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	mkdirSync(join(base, "agent"));
	mkdirSync(join(base, "scratch"));
	const saved = Object.fromEntries(["XDG_CACHE_HOME", "PI_SCRATCHPAD_DIR"].map((k) => [k, process.env[k]]));
	Object.assign(process.env, { XDG_CACHE_HOME: join(base, "cache"), PI_SCRATCHPAD_DIR: join(base, "scratch") });
	const sessions = [];
	t.after(() => {
		for (const session of sessions) session.dispose?.();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(base, { recursive: true, force: true });
	});

	/** A session in `mode` with `flags`; `answers` are the keys the fake user presses in the modal. */
	async function open({ mode = "print", flags = {}, answers = [], autoPlans } = {}) {
		const eventBus = sdk.createEventBus();
		const loader = new sdk.DefaultResourceLoader({
			eventBus,
			cwd,
			agentDir: join(base, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [
				new URL("../index.ts", import.meta.url).pathname,
				new URL("../../jobs/index.ts", import.meta.url).pathname,
			],
		});
		await loader.reload();
		const { session } = await sdk.createAgentSession({
			cwd,
			agentDir: join(base, "agent"),
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(),
		});
		sessions.push(session);
		for (const [name, value] of Object.entries(flags)) session.extensionRunner.setFlagValue(name, value);
		const reviewCalls = [];
		if (autoPlans) {
			const model = { type: "chat", id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses", name: "Luna", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			const registry = session.extensionRunner.getModelRegistry();
			registry.find = (provider, id) => { assert.equal(`${provider}/${id}`, "openai-codex/gpt-6-luna"); return model; };
			registry.hasConfiguredAuth = () => true;
			registry.streamSimple = (_model, context, options) => {
				reviewCalls.push({ context: structuredClone(context), options });
				const stream = createAssistantMessageEventStream();
				const plan = autoPlans.shift();
				assert.notEqual(plan, undefined, "unexpected reviewer request");
				const finish = (value) => {
					const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
					const message = { role: "assistant", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
				};
				if (typeof plan === "function") plan(finish);
				else queueMicrotask(() => finish(plan));
				return stream;
			};
		}
		const shown = [];
		const statuses = new Map();
		const uiContext = {
			theme: plainTheme,
			custom: (factory) =>
				new Promise((resolve) => {
					const component = factory({ requestRender() {} }, plainTheme, {}, resolve);
					shown.push(component.render(100).join("\n"));
					const key = answers.shift();
					setTimeout(() => component.handleInput(key), 320);
				}),
			input: async () => "use the project venv",
			select: async () => undefined,
			notify() {},
			setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
		};
		const errors = [];
		await session.bindExtensions({ mode, onError: (error) => errors.push(String(error.error)), ...(mode === "tui" ? { uiContext } : {}) });
		let n = 0;
		const call = (toolName, input) =>
			session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: `c${++n}`, toolName, input });
		const customs = (type) =>
			session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data);
		return { session, call, shown, errors, customs, eventBus, statuses, reviewCalls };
	}
	return { base, cwd, open };
}

test("print mode: the default permissions run, the rest is denied", { skip: !sdkPath }, async (t) => {
	const { base, cwd, open } = await setup(t);
	const { call, errors } = await open({ flags: { "enable-sandbox": true } });
	assert.deepEqual(errors, []);
	assert.equal(await call("bash", { command: "make", sandbox: { writableLocations: [cwd], networkAccess: "fetch-only" } }), undefined);
	assert.equal(await call("write", { path: join(cwd, "a.txt"), content: "" }), undefined);
	assert.equal(await call("write", { path: join(base, "scratch", "n.md"), content: "" }), undefined, "scratchpad");
	const outside = await call("bash", { command: "x", sandbox: { writableLocations: [join(base, "other")] } });
	assert.equal(outside.block, true);
	assert.match(outside.reason, /^Blocked: bash needs writableLocations .*other, beyond this run's permissions \(write .*project · net fetch-only · other tools\)/);
	assert.match((await call("edit", { path: join(base, "x.ts"), edits: [] })).reason, /^Blocked: edit needs write to /);
	assert.match((await call("bash", { command: "x", sandbox: { writable: [] } })).reason, /Unknown sandbox field writable/);

	const skip = { dangerouslySkipSandbox: true };
	assert.equal(await call("job_start", { command: 'pi -p --permissions read-only "review"', sandbox: skip }), undefined);
	assert.match((await call("job_start", { command: 'pi -p "review"', sandbox: skip })).reason, /needs dangerouslySkipSandbox/);
});

test("--permissions replaces the default and is recorded in the session", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { call, customs } = await open({ flags: { permissions: "read-only" } });
	assert.match((await call("bash", { command: "x", sandbox: { writableLocations: [cwd] } })).reason, /permissions \(read-only\)/);
	assert.equal(customs("sandbox-permissions").length, 1);
});

test("manual review: approve, always, deny with feedback; marks and permissions persist", { skip: !sdkPath }, async (t) => {
	const { base, open } = await setup(t);
	const other = join(base, "other");
	const { session, call, shown, customs, statuses } = await open({ mode: "tui", flags: { "enable-sandbox": true }, answers: ["y", "a", "f", "y"] });
	const initialStatus = statuses.get("sandbox-permissions");
	assert.match(initialStatus, /^⛶ rw .*project · net fetch-only · tools all$/);
	const grant = { command: "uv sync", sandbox: { writableLocations: [other] } };

	assert.equal(await call("bash", grant), undefined, "approved once");
	assert.equal(statuses.get("sandbox-permissions"), initialStatus, "one-off approval does not change permissions");
	assert.match(shown[0], /Permission request · bash/);
	assert.match(shown[0], /\$ uv sync/);
	assert.match(shown[0], /⚠ writableLocations[\s\S]*other/);
	assert.equal(await call("bash", grant), undefined, "approved always");
	assert.ok(statuses.get("sandbox-permissions").includes(other), "always refreshes the permission badge");
	assert.equal(await call("bash", grant), undefined, "now pre-approved");
	assert.equal(shown.length, 2, "no modal for a pre-approved call");

	const denied = await call("write", { path: join(base, "elsewhere", "f.txt"), content: "x" });
	assert.equal(denied.block, true);
	assert.match(denied.reason, /^The user denied this call: write needs write to .*f\.txt\. Feedback: use the project venv/);
	assert.match(shown[2], /create[\s\S]*f\.txt/);

	assert.deepEqual(customs("sandbox-review"), [
		{ toolCallId: "c1", mark: "approved" },
		{ toolCallId: "c2", mark: "always" },
		{ toolCallId: "c4", mark: "denied" },
	]);
	assert.ok(customs("sandbox-permissions").at(-1).policy.writable.includes(other));

	// The badge mark is drawn under the tool's own call rendering.
	const bash = session.getToolDefinition("bash");
	const renderers = session.extensionRunner.resolveToolRenderers("bash", () => ({ renderCall: bash.renderCall }));
	const context = (toolCallId) => ({ toolCallId, state: {}, executionStarted: true, lastComponent: undefined });
	const row = (id) => renderers.renderCall(grant, plainTheme, context(id)).render(120).join("\n");
	assert.match(row("c1"), /\$ uv sync[\s\S]*⛶ rw [\s\S]*✓ approved/);
	assert.match(row("c2"), /✓ always/);
	assert.doesNotMatch(row("c3"), /✓|✗/);

	// Review marks wrap jobs' own command renderer plus the sandbox access badge.
	const jobStart = session.getToolDefinition("job_start");
	assert.ok(jobStart.parameters.properties.sandbox, "the real jobs tool is sandbox-aware");
	assert.equal(typeof jobStart.renderCall, "function", "jobs provides its own renderer");
	const jobArgs = { command: "build", timeout: 30, sandbox: { networkAccess: "full" } };
	assert.equal(await call("job_start", jobArgs), undefined);
	const resultRenderer = () => {};
	const jobRenderers = session.extensionRunner.resolveToolRenderers("job_start", () => ({ renderCall: jobStart.renderCall, renderResult: resultRenderer }));
	assert.equal(jobRenderers.renderResult, resultRenderer);
	const jobRow = jobRenderers.renderCall(jobArgs, plainTheme, context("c5")).render(120).join("\n");
	assert.match(jobRow, /\$ build \(timeout 30s\)[\s\S]*⛶ read-only · net FULL[\s\S]*✓ approved/);
});

test("footer status restores permissions from flags and the active session branch", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { session, statuses } = await open({ mode: "tui", flags: { permissions: "read-only" } });
	assert.equal(statuses.get("sandbox-permissions"), "⛶ read-only");
	const stored = parsePermissions('{"networkAccess":"full","sessionBusAccess":true}', cwd, homedir());
	session.sessionManager.appendCustomEntry("sandbox-permissions", stored);
	await session.extensionRunner.emit({ type: "session_tree", newLeafId: session.sessionManager.getLeafId(), oldLeafId: null });
	assert.equal(statuses.get("sandbox-permissions"), "⛶ read-only · net FULL · d-bus");
});

test("footer shows the effective fail-closed permissions on configuration errors", { skip: !sdkPath }, async (t) => {
	const { open } = await setup(t);
	const { statuses, errors } = await open({ mode: "tui", flags: { reviewer: "auto", "reviewer-model": "bad" } });
	assert.match(errors.join("\n"), /provider\/model/);
	assert.equal(statuses.get("sandbox-permissions"), "⛶ read-only (config error)");
});

test("restrict() fixes read-only with the deny reviewer, even in the TUI", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { call, shown, eventBus, statuses } = await open({ mode: "tui", flags: { "enable-sandbox": true }, answers: ["y"] });
	let provider;
	// The provider channel is the extension's internal interface (see sandbox.ts PROVIDER_CHANNEL).
	eventBus.emit("archibate.sandbox:get", (p) => {
		provider = p;
	});
	assert.ok(provider, "provider answered");
	provider.restrict("read-only");
	assert.equal(statuses.get("sandbox-permissions"), "⛶ read-only");
	const blocked = await call("bash", { command: "x", sandbox: { writableLocations: [cwd] } });
	assert.match(blocked.reason, /^Blocked: .*permissions \(read-only\)/);
	assert.equal(shown.length, 0, "no modal");
});

test("auto uses Luna only beyond permissions, records one-shot decisions and restores origin marks", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { session, call, shown, customs, reviewCalls, errors } = await open({ flags: { reviewer: "auto" }, autoPlans: [
		{ decision: "approve", reason: "User authorized this action." },
		{ decision: "deny", reason: "Keep this action local." },
	] });
	assert.deepEqual(errors, []);
	assert.equal(reviewCalls.length, 0, "startup is lazy");
	await call("bash", { command: "inspect" });
	assert.equal(reviewCalls.length, 0, "pre-approved calls do not use model quota");
	const grant = { command: "fetch", sandbox: { networkAccess: "full" } };
	assert.equal(await call("bash", grant), undefined);
	assert.match((await call("bash", grant)).reason, /^Blocked by automatic review:.*Keep this action local/);
	assert.equal(reviewCalls.length, 2, "automatic approval never widens permissions");
	assert.equal(customs("sandbox-permissions").length, 0);
	assert.equal(customs("sandbox-auto-review").length, 2);
	assert.deepEqual(customs("sandbox-review").map((r) => r.mark), ["auto-approved", "auto-denied"]);
	assert.equal(shown.length, 0);
	await session.extensionRunner.emit({ type: "session_tree", newLeafId: session.sessionManager.getLeafId(), oldLeafId: null });
	const bash = session.getToolDefinition("bash");
	const renderers = session.extensionRunner.resolveToolRenderers("bash", () => ({ renderCall: bash.renderCall }));
	const rendered = renderers.renderCall(grant, plainTheme, { toolCallId: "c2", state: {}, executionStarted: true }).render(80).join("\n");
	assert.match(rendered, /✓ auto approved/);
	assert.equal(await call("write", { path: join(cwd, "a.txt"), content: "" }), undefined);
});

test("auto-manual presents Luna's denial and retains human always semantics", { skip: !sdkPath }, async (t) => {
	const { base, open } = await setup(t);
	const { call, shown, customs } = await open({ mode: "tui", flags: { reviewer: "auto-manual" }, answers: ["a"], autoPlans: [{ decision: "deny", reason: "This cache is outside the workspace; confirm its ownership." }] });
	const grant = { command: "uv sync", sandbox: { writableLocations: [join(base, "outside")] } };
	assert.equal(await call("bash", grant), undefined);
	assert.match(shown[0], /Automatic review:[\s\S]*outside the workspace/);
	assert.equal(customs("sandbox-review")[0].mark, "always");
	assert.equal(await call("bash", grant), undefined);
	assert.equal(shown.length, 1);
});

test("permission edits cancel in-flight automatic approval without executing or escalating", { skip: !sdkPath }, async (t) => {
	const { open } = await setup(t);
	let finish;
	const { session, call, shown, reviewCalls } = await open({ mode: "tui", flags: { reviewer: "auto-manual" }, autoPlans: [(resolve) => { finish = resolve; }] });
	const pending = call("bash", { command: "fetch", sandbox: { networkAccess: "full" } });
	await waitForReview(reviewCalls);
	const runner = session.extensionRunner;
	await runner.getCommand("permissions").handler("read-only", runner.createCommandContext());
	const blocked = await pending;
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /Review cancelled/);
	finish({ decision: "approve", reason: "Late approval." });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(shown.length, 0, "cancelled review must not reopen the human modal");
});

test("branch changes reject queued reviews and do not persist stale decisions on the new branch", { skip: !sdkPath }, async (t) => {
	const { open } = await setup(t);
	let finish;
	const { session, call, customs, reviewCalls } = await open({ flags: { reviewer: "auto" }, autoPlans: [(resolve) => { finish = resolve; }] });
	const grant = { command: "fetch", sandbox: { networkAccess: "full" } };
	const first = call("bash", grant);
	const queued = call("bash", grant);
	await waitForReview(reviewCalls);
	session.sessionManager.resetLeaf();
	await session.extensionRunner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	assert.equal((await first).block, true);
	assert.equal((await queued).block, true);
	finish({ decision: "approve", reason: "Stale branch." });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(reviewCalls.length, 1);
	assert.deepEqual(customs("sandbox-auto-review"), []);
	assert.deepEqual(customs("sandbox-review"), []);
});

test("modified call input cannot use an approval for the original proposal", { skip: !sdkPath }, async (t) => {
	const { open } = await setup(t);
	let finish;
	const { call, reviewCalls } = await open({ flags: { reviewer: "auto" }, autoPlans: [(resolve) => { finish = resolve; }] });
	const input = { command: "original", sandbox: { networkAccess: "full" } };
	const pending = call("bash", input);
	await waitForReview(reviewCalls);
	input.command = "changed";
	finish({ decision: "approve", reason: "Approve the original proposal." });
	assert.match((await pending).reason, /proposed call changed/);
});

test("a changed canonical grant target invalidates approval even when the input is unchanged", { skip: !sdkPath }, async (t) => {
	const { base, open } = await setup(t);
	for (const path of ["target-a", "target-b"]) mkdirSync(join(base, path));
	const alias = join(base, "alias");
	symlinkSync(join(base, "target-a"), alias);
	let finish;
	const { call, reviewCalls } = await open({ flags: { reviewer: "auto" }, autoPlans: [(resolve) => { finish = resolve; }] });
	const input = { command: "touch file", sandbox: { writableLocations: [alias] } };
	const pending = call("bash", input);
	await waitForReview(reviewCalls);
	unlinkSync(alias);
	symlinkSync(join(base, "target-b"), alias);
	finish({ decision: "approve", reason: "Approve target-a only." });
	assert.match((await pending).reason, /Review cancelled/);
});

test("changed effective instructions invalidate an in-flight approval", { skip: !sdkPath }, async (t) => {
	const { open } = await setup(t);
	let finish;
	const { call, session, reviewCalls } = await open({ flags: { reviewer: "auto" }, autoPlans: [(resolve) => { finish = resolve; }] });
	const pending = call("bash", { command: "touch file", sandbox: { networkAccess: "full" } });
	await waitForReview(reviewCalls);
	const before = session.systemPrompt;
	session.setActiveToolsByName(["read"]);
	assert.notEqual(session.systemPrompt, before);
	finish({ decision: "approve", reason: "Approve under the original instructions." });
	assert.match((await pending).reason, /Review cancelled/);
});

test("an invalid --reviewer is reported and fails closed to read-only", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { call, errors } = await open({ flags: { reviewer: "manual" } });
	assert.match(errors.join("\n"), /--reviewer manual needs the interactive TUI/);
	const blocked = await call("bash", { command: "x", sandbox: { writableLocations: [cwd] } });
	assert.match(blocked.reason, /^Blocked: .*\(read-only\).*--reviewer manual needs the interactive TUI/);
});
