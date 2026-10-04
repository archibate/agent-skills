import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import rewindExtension from "../index.ts";

/** Minimal stand-in for the pi ExtensionAPI: records handlers, dispatches events. */
function createPiMock() {
	const handlers = new Map();
	const commands = new Map();
	const appended = [];
	return {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
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
		appended,
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

	return { sessionManager, commands: pi.commands };
}

function commandContext(env, sessionManager, action) {
	const calls = { navigated: [], notifications: [] };
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
				select: async (_title, options) => (_title.startsWith("Rewind to which") ? options[0] : action),
				notify: (text) => calls.notifications.push(text),
			},
		},
	};
}

test("captures a per-prompt checkpoint and restores code and conversation", async (t) => {
	const env = freshEnv(t);
	const { sessionManager, commands } = await captureOnePrompt(t, env);

	// The pre-image capture must not have touched the checkpoint's own files.
	assert.equal(readFileSync(join(env.cwd, "a.txt"), "utf8"), "modified");
	assert.equal(existsSync(join(env.cwd, "b.txt")), true);

	const { ctx, calls } = commandContext(env, sessionManager, "Restore code and conversation");
	await commands.get("rewind").handler("", ctx);

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
