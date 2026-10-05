import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parsePermissions } from "../permissions.ts";

// Offline: loads the real pi runtime with the sandbox extension and drives tool_call review. The
// manual reviewer gets a fake UI that answers the modal; no terminal, model, or network is used.
const sdkPath = process.env.PI_SDK_PATH;
const plainTheme = { fg: (_color, text) => text, bold: (text) => text };

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
	async function open({ mode = "print", flags = {}, answers = [] } = {}) {
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
		return { session, call, shown, errors, customs, eventBus, statuses };
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

	// The marks resolver wraps job_start's shared renderer even with no tool-level renderCall.
	const jobStart = session.getToolDefinition("job_start");
	assert.ok(jobStart.parameters.properties.sandbox, "the real jobs tool is sandbox-aware");
	assert.equal(jobStart.renderCall, undefined, "the sandbox provides the renderer independently");
	const jobArgs = { command: "build", timeout: 30, sandbox: { networkAccess: "full" } };
	assert.equal(await call("job_start", jobArgs), undefined);
	const resultRenderer = () => {};
	const jobRenderers = session.extensionRunner.resolveToolRenderers("job_start", () => ({ renderResult: resultRenderer }));
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
	const { statuses, errors } = await open({ mode: "tui", flags: { reviewer: "auto" } });
	assert.match(errors.join("\n"), /not available yet/);
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

test("an invalid --reviewer is reported and fails closed to read-only", { skip: !sdkPath }, async (t) => {
	const { cwd, open } = await setup(t);
	const { call, errors } = await open({ flags: { reviewer: "manual" } });
	assert.match(errors.join("\n"), /--reviewer manual needs the interactive TUI/);
	const blocked = await call("bash", { command: "x", sandbox: { writableLocations: [cwd] } });
	assert.match(blocked.reason, /^Blocked: .*\(read-only\).*--reviewer manual needs the interactive TUI/);
});
