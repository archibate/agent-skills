import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import rewindExtension from "../index.ts";

/** Minimal stand-in for the pi ExtensionAPI: records handlers, dispatches events. */
function createPiMock() {
	const handlers = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const appended = [];
	const sentMessages = [];
	return {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
		},
		sendUserMessage(content, options) {
			sentMessages.push({ content, options });
		},
		async emit(event, payload, ctx) {
			let result;
			for (const handler of handlers.get(event) ?? []) {
				const current = await handler(payload, ctx);
				if (current !== undefined) result = current;
			}
			return result;
		},
		commands,
		shortcuts,
		appended,
		sentMessages,
	};
}

/** Minimal session tree; entries are linked by parentId and the leaf advances on append. */
function createSessionManager(sessionId = "session-1") {
	const entries = [];
	let leafId = null;
	return {
		getSessionId: () => sessionId,
		getEntries: () => entries,
		getLeafId: () => leafId,
		getEntry: (id) => entries.find((entry) => entry.id === id),
		getBranch() {
			const chain = [];
			let current = leafId;
			while (current) {
				const entry = entries.find((candidate) => candidate.id === current);
				if (!entry) break;
				chain.unshift(entry);
				current = entry.parentId;
			}
			return chain;
		},
		append(entry) {
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
	};
}

function userEntry(id, parentId = null) {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "do work" } };
}

function freshEnv(t) {
	const base = mkdtempSync(join(tmpdir(), "pi-rewind-integration-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(base, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(base, { recursive: true, force: true });
	});
	return { base, cwd: join(base, "project") };
}

/** Runs one agent turn that edits a.txt and creates b.txt, and returns the session. */
async function captureOnePrompt(t, env) {
	mkdirSync(env.cwd, { recursive: true });
	const sessionManager = createSessionManager();
	sessionManager.append(userEntry("u1"));
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	const pi = createPiMock();
	rewindExtension(pi);

	await pi.emit("session_start", { type: "session_start" }, ctx);
	await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);

	// pi's edit tool: snapshot the pre-image, then mutate.
	writeFileSync(join(env.cwd, "a.txt"), "initial");
	await pi.emit("tool_call", { toolName: "edit", input: { path: "a.txt", edits: [] } }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "modified");

	// pi's write tool creating a new file.
	await pi.emit("tool_call", { toolName: "write", input: { path: "b.txt", content: "created" } }, ctx);
	writeFileSync(join(env.cwd, "b.txt"), "created");

	const boundary = await pi.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
	assert.equal(boundary.entries.length, 1);
	const draft = boundary.entries[0];
	assert.equal(draft.type, "custom");
	assert.equal(draft.customType, "rewind");

	// The runtime commits the draft as a session entry; do the same here.
	sessionManager.append({ ...draft, id: "cp1", parentId: sessionManager.getLeafId(), timestamp: new Date().toISOString() });
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);

	return { sessionManager, commands: pi.commands, shortcuts: pi.shortcuts, sentMessages: pi.sentMessages };
}

function commandContext(env, sessionManager, action) {
	const calls = { navigated: [], notifications: [], selections: [] };
	return {
		calls,
		ctx: {
			hasUI: true,
			cwd: env.cwd,
			sessionManager,
			navigateTree: async (entryId) => {
				calls.navigated.push(entryId);
				return { cancelled: false };
			},
			ui: {
				select: async (title, options) => {
					calls.selections.push({ title, options });
					return title.startsWith("Rewind to which") ? options[0] : action;
				},
				notify: (text) => calls.notifications.push(text),
			},
		},
	};
}

/** Commits the settle boundary's checkpoint draft the way the pi runtime does. */
async function appendDraft(pi, sessionManager, ctx, id) {
	const boundary = await pi.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
	sessionManager.append({
		...boundary.entries[0],
		id,
		parentId: sessionManager.getLeafId(),
		timestamp: new Date().toISOString(),
	});
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
}

function writeConfig(config) {
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "rewind.json"), JSON.stringify(config));
}

function blobDir(env) {
	return join(process.env.PI_CODING_AGENT_DIR, "rewind", "session-1", "blobs");
}

test("captures a per-prompt checkpoint and restores code and conversation", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	// The pre-image capture must not have touched the checkpoint's own files.
	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "modified");
	assert.equal(existsSync(join(env.cwd, "b.txt")), true);

	const { ctx, calls } = commandContext(env, sessionManager, "Restore code and conversation");
	await commands.get("rewind").handler("", ctx);

	// The picker labels each checkpoint with its user prompt as well as its files.
	assert.match(calls.selections[0].options[0], /"do work"/);
	assert.match(calls.selections[0].options[0], /a\.txt/);
	assert.match(calls.selections[0].options[0], /\+2 -1/);
	assert.match(calls.selections[1].title, /"do work"/);

	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "initial");
	assert.equal(existsSync(join(env.cwd, "b.txt")), false);
	assert.deepEqual(calls.navigated, ["u1"]);
});

test("conversation-only restore leaves files untouched", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	const { ctx, calls } = commandContext(env, sessionManager, "Restore conversation only");
	await commands.get("rewind").handler("", ctx);

	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "modified");
	assert.equal(existsSync(join(env.cwd, "b.txt")), true);
	assert.deepEqual(calls.navigated, ["u1"]);
});

test("code-only restore does not navigate the conversation", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	const { ctx, calls } = commandContext(env, sessionManager, "Restore code only");
	await commands.get("rewind").handler("", ctx);

	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "initial");
	assert.deepEqual(calls.navigated, []);
});

test("ctrl+alt+r dispatches /rewind through the command pipeline", async (t) => {
	const env = freshEnv(t);
	const { shortcuts, sentMessages } = await captureOnePrompt(t, env);

	const shortcut = shortcuts.get("ctrl+alt+r");
	assert.ok(shortcut, "ctrl+alt+r is registered");

	const notifications = [];
	const baseCtx = { hasUI: true, isIdle: () => true, ui: { notify: (text) => notifications.push(text) } };
	shortcut.handler(baseCtx);
	assert.deepEqual(sentMessages, [{ content: "/rewind", options: { expandPromptTemplates: true } }]);
	assert.deepEqual(notifications, []);

	// While streaming, the shortcut refuses instead of re-dispatching.
	sentMessages.length = 0;
	shortcut.handler({ ...baseCtx, isIdle: () => false });
	assert.deepEqual(sentMessages, []);
	assert.equal(notifications.length, 1);
});

test("picker shows a single-line, truncated user-prompt preview", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	// Long prompt with a hard line break must collapse to one truncated line.
	sessionManager.getEntry("u1").message.content = `first line\nsecond line ${"x".repeat(200)}`;
	const { ctx, calls } = commandContext(env, sessionManager, "Restore code only");
	await commands.get("rewind").handler("", ctx);

	const option = calls.selections[0].options[0];
	assert.ok(option.includes("first line second line"), option);
	assert.ok(option.includes("…"), option);
	assert.ok(!option.includes("\n"), option);
	assert.ok(option.length < 120, option);
});

test("picker tolerates a checkpoint whose prompt entry is gone", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	// The prompt entry may no longer be resolvable, e.g. after compaction.
	sessionManager.getEntry = () => undefined;
	const { ctx, calls } = commandContext(env, sessionManager, "Restore code only");
	await commands.get("rewind").handler("", ctx);

	const option = calls.selections[0].options[0];
	assert.ok(option.includes("a.txt"), option);
	assert.ok(!option.includes("do work"), option);
});

test("checkpoints survive a reload and are reconstructed from session entries", async (t) => {
	const env = freshEnv(t);
	const { sessionManager } = await captureOnePrompt(t, env);

	// A fresh extension instance over the same session, as after /reload or --resume.
	const pi = createPiMock();
	rewindExtension(pi);
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	await pi.emit("session_start", { type: "session_start" }, ctx);

	const { ctx: commandCtx, calls } = commandContext(env, sessionManager, "Restore code only");
	await pi.commands.get("rewind").handler("", commandCtx);

	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "initial");
	assert.equal(existsSync(join(env.cwd, "b.txt")), false);
	assert.ok(calls.notifications.some((text) => text.startsWith("Code rewind:")));
});

test("oversized files are recorded as uncaptured instead of silently skipped", async (t) => {
	const env = freshEnv(t);
	writeConfig({ maxFileBytes: 4 });
	mkdirSync(env.cwd, { recursive: true });
	const sessionManager = createSessionManager();
	sessionManager.append(userEntry("u1"));
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	const pi = createPiMock();
	rewindExtension(pi);

	await pi.emit("session_start", { type: "session_start" }, ctx);
	await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);
	writeFileSync(join(env.cwd, "big.txt"), "12345");
	await pi.emit("tool_call", { toolName: "edit", input: { path: "big.txt" } }, ctx);
	writeFileSync(join(env.cwd, "big.txt"), "changed");
	await appendDraft(pi, sessionManager, ctx, "cp1");

	const { ctx: commandCtx, calls } = commandContext(env, sessionManager, "Restore code only");
	await pi.commands.get("rewind").handler("", commandCtx);

	assert.match(calls.selections[0].options[0], /big\.txt/);
	assert.equal(readFileSync(join(env.cwd, "big.txt"), "utf8"), "changed");
	assert.ok(calls.notifications.some((text) => /1 not captured/.test(text)), calls.notifications.join(" | "));
});

test("the byte budget evicts the oldest checkpoints and frees their blobs", async (t) => {
	const env = freshEnv(t);
	writeConfig({ maxBytes: 10, maxFileBytes: 1000 });
	mkdirSync(env.cwd, { recursive: true });
	const sessionManager = createSessionManager();
	const pi = createPiMock();
	rewindExtension(pi);
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	await pi.emit("session_start", { type: "session_start" }, ctx);

	// Prompt 1 stores an 8-byte pre-image.
	sessionManager.append(userEntry("u1"));
	await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "11111111");
	await pi.emit("tool_call", { toolName: "edit", input: { path: "a.txt" } }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "222222222");
	await appendDraft(pi, sessionManager, ctx, "cp1");

	// Prompt 2 stores 9 more bytes, so the session goes over maxBytes.
	sessionManager.append(userEntry("u2", sessionManager.getLeafId()));
	await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);
	await pi.emit("tool_call", { toolName: "edit", input: { path: "a.txt" } }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "333333333");
	await appendDraft(pi, sessionManager, ctx, "cp2");

	// The evicted checkpoint's blob is gone, the surviving one remains.
	assert.deepEqual(readdirSync(blobDir(env)).length, 1);

	const { ctx: commandCtx, calls } = commandContext(env, sessionManager, "Restore code only");
	await pi.commands.get("rewind").handler("", commandCtx);

	assert.equal(calls.selections[0].options.length, 1);
	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "222222222");
});

test("session start collects blobs no checkpoint references", async (t) => {
	const env = freshEnv(t);
	mkdirSync(env.cwd, { recursive: true });
	const sessionManager = createSessionManager();
	sessionManager.append(userEntry("u1"));
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	const pi = createPiMock();
	rewindExtension(pi);

	await pi.emit("session_start", { type: "session_start" }, ctx);
	await pi.emit("before_agent_start", { type: "before_agent_start" }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "initial");
	await pi.emit("tool_call", { toolName: "edit", input: { path: "a.txt" } }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "modified");
	await appendDraft(pi, sessionManager, ctx, "cp1");

	// A blob left behind by a run that crashed before committing its checkpoint.
	writeFileSync(join(blobDir(env), "f".repeat(64)), "orphan");

	const reloaded = createPiMock();
	rewindExtension(reloaded);
	await reloaded.emit("session_start", { type: "session_start" }, ctx);

	const remaining = readdirSync(blobDir(env));
	assert.equal(remaining.includes("f".repeat(64)), false);
	assert.equal(remaining.length, 1);

	// The referenced blob survived, so the checkpoint still restores.
	const { ctx: commandCtx } = commandContext(env, sessionManager, "Restore code only");
	await reloaded.commands.get("rewind").handler("", commandCtx);
	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "initial");
});

// Optional real-runtime check. Set PI_SDK_PATH to the release's dist/index.js to run it.
const sdkPath = process.env.PI_SDK_PATH;

test("real pi runtime: a user prompt produces a checkpoint anchored to that user message", { skip: !sdkPath }, async (t) => {
	const sdk = await import(new URL(`file://${sdkPath}`).href);
	const base = mkdtempSync(join(tmpdir(), "pi-rewind-runtime-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(base, { recursive: true, force: true });
	});

	const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
		const services = await sdk.createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
			},
		});
		return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services };
	};
	const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: sdk.SessionManager.create(cwd, join(base, "sessions")),
	});
	t.after(() => runtime.dispose());
	const errors = [];
	await runtime.session.bindExtensions({ onError: (error) => errors.push(error.error), mode: "print" });
	const runner = runtime.session.extensionRunner;
	assert.ok(runner.getShortcuts({}).has("ctrl+alt+r"), "ctrl+alt+r is registered in the real runtime");

	const userEntry = runtime.session.sessionManager.appendMessage({ role: "user", content: "edit a.txt", timestamp: Date.now() });
	await runner.emitBeforeAgentStart("edit a.txt", undefined, { cwd });
	await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });

	writeFileSync(join(cwd, "a.txt"), "initial");
	await runner.emitToolCall({
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "edit",
		input: { path: "a.txt", edits: [{ oldText: "initial", newText: "modified" }] },
	});
	writeFileSync(join(cwd, "a.txt"), "modified");

	const boundary = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () => ({
		contextEntries: [],
		contextMessages: [],
		llmMessages: [],
		pendingMessages: [],
		canContinue: true,
	}));
	assert.deepEqual(errors, []);
	assert.equal(boundary.entries.length, 1);
	assert.equal(boundary.entries[0].customType, "rewind");
	assert.equal(boundary.entries[0].data.entryId, userEntry);
	assert.deepEqual(boundary.entries[0].data.files.map((file) => file.path), ["a.txt"]);
});

test("an aborted run still persists its captures at agent_settled", async (t) => {
	const env = freshEnv(t);
	mkdirSync(env.cwd, { recursive: true });
	const sessionManager = createSessionManager();
	sessionManager.append(userEntry("u1"));
	const ctx = { hasUI: false, cwd: env.cwd, sessionManager };
	const pi = createPiMock();
	rewindExtension(pi);

	await pi.emit("session_start", { type: "session_start" }, ctx);
	await pi.emit("before_agent_start", { type: "agent_before_settle" }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "initial");
	await pi.emit("tool_call", { toolName: "edit", input: { path: "a.txt", edits: [] } }, ctx);
	writeFileSync(join(env.cwd, "a.txt"), "modified");

	// Aborted before the settle boundary: no agent_before_settle event.
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);

	assert.equal(pi.appended.length, 1);
	assert.equal(pi.appended[0].customType, "rewind");
	assert.equal(pi.appended[0].data.entryId, "u1");
	assert.deepEqual(pi.appended[0].data.files.map((file) => file.path), ["a.txt"]);

	// The appended entry makes the checkpoint recoverable after a reload.
	const draft = pi.appended[0];
	sessionManager.append({
		type: "custom",
		customType: draft.customType,
		data: draft.data,
		id: "cp1",
		parentId: sessionManager.getLeafId(),
		timestamp: new Date().toISOString(),
	});
	const reloaded = createPiMock();
	rewindExtension(reloaded);
	await reloaded.emit("session_start", { type: "session_start" }, ctx);
	const { ctx: commandCtx } = commandContext(env, sessionManager, "Restore code only");
	await reloaded.commands.get("rewind").handler("", commandCtx);
	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "initial");
});
