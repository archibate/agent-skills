import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import scratchpadExtension from "../index.ts";

const fixtureRoot = join(homedir(), ".cache");
mkdirSync(fixtureRoot, { recursive: true });

function fixture(t) {
	const base = mkdtempSync(join(fixtureRoot, "pi-scratchpad-test-"));
	const original = { TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, HOME: process.env.HOME };
	process.env.XDG_CACHE_HOME = join(base, "cache");
	process.env.HOME = join(base, "home");
	delete process.env.TMPDIR;
	t.after(() => {
		for (const [name, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(base, { recursive: true, force: true });
	});
	return base;
}

function harness(sessionId = "session-a") {
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		hasUI: true,
		ui: { notify: (...args) => notices.push(args) },
	};
	scratchpadExtension({
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	return {
		ctx, commands, notices,
		emit(name, event = {}) { return handlers.get(name)(event, ctx); },
		setSession(id) { sessionId = id; },
	};
}

// Tests mutate process.env, so keep them sequential in this single test process.
test("registration has no filesystem or environment side effects", (t) => {
	fixture(t);
	const env = { ...process.env };
	harness();
	assert.equal(Object.keys(process.env).length, Object.keys(env).length);
	assert.ok(Object.keys(env).every((name) => process.env[name] === env[name]), "environment changed during registration");
	assert.equal(existsSync(process.env.XDG_CACHE_HOME), false);
});

test("private directory, inherited TMPDIR, mktemp and unchanged cwd", (t) => {
	fixture(t);
	const h = harness();
	h.emit("session_start", { reason: "startup" });
	const expected = join(process.env.XDG_CACHE_HOME, "pi", "scratchpad", "session-a");
	assert.equal(process.env.TMPDIR, expected);
	assert.equal(tmpdir(), expected);
	for (const path of [expected, dirname(expected), dirname(dirname(expected))]) {
		assert.equal(statSync(path).mode & 0o777, 0o700);
		assert.equal(statSync(path).uid, process.getuid());
	}
	const [env, cwd, temp] = execFileSync("bash", ["-c", 'printf "%s\\n" "$TMPDIR" "$PWD"; mktemp'], { encoding: "utf8" }).trim().split("\n");
	assert.equal(env, expected);
	assert.equal(cwd, process.cwd());
	assert.equal(dirname(temp), expected);
	h.emit("session_shutdown", { reason: "quit" });
	assert.equal(process.env.TMPDIR, undefined);
	assert.equal(existsSync(temp), true);
});

test("prompt advertises the absolute path and bash shortcut, preserves rules and does not duplicate", (t) => {
	fixture(t);
	const h = harness();
	h.emit("session_start");
	const event = { systemPromptOptions: { promptGuidelines: ["Existing rule"] } };
	h.emit("before_agent_start", event);
	h.emit("before_agent_start", event);
	const rules = event.systemPromptOptions.promptGuidelines;
	assert.equal(rules.length, 2);
	assert.equal(rules[0], "Existing rule");
	assert.match(rules[1], /\$TMPDIR/);
	assert.match(rules[1], /In bash/);
	assert.match(rules[1], /absolute path with read\/write\/edit/);
	assert.match(rules[1], /do not expand environment variables/);
	assert.equal(rules[1].includes(JSON.stringify(process.env.TMPDIR)), true);
	assert.equal(rules[1].includes("PI_SCRATCHPAD_DIR"), false);
});

test("reload/resume reuse results; new/fork use separate directories", (t) => {
	fixture(t);
	process.env.TMPDIR = "/original-temp";
	let h = harness();
	h.emit("session_start");
	const first = process.env.TMPDIR;
	writeFileSync(join(first, "result.txt"), "keep me");
	for (const reason of ["reload", "resume"]) {
		h.emit("session_shutdown", { reason });
		assert.equal(process.env.TMPDIR, "/original-temp");
		h = harness(); // Pi reloads extension factories as well as the active session.
		h.emit("session_start", { reason });
		assert.equal(process.env.TMPDIR, first);
		assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "keep me");
	}
	for (const reason of ["new", "fork"]) {
		h.emit("session_shutdown", { reason });
		h = harness(`session-${reason}`);
		h.emit("session_start", { reason });
		assert.notEqual(process.env.TMPDIR, first);
		assert.equal(existsSync(join(process.env.TMPDIR, "result.txt")), false);
		const event = { systemPromptOptions: { promptGuidelines: [] } };
		h.emit("before_agent_start", event);
		assert.equal(event.systemPromptOptions.promptGuidelines[0].includes(process.env.TMPDIR), true);
		assert.equal(event.systemPromptOptions.promptGuidelines[0].includes(first), false);
	}
	h.emit("session_shutdown", { reason: "quit" });
	h.emit("session_shutdown", { reason: "quit" });
	assert.equal(process.env.TMPDIR, "/original-temp");
	assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "keep me");
});

test("shutdown does not overwrite a later environment change", (t) => {
	fixture(t);
	const h = harness();
	h.emit("session_start");
	process.env.TMPDIR = "/another-extension-temp";
	h.emit("session_shutdown");
	assert.equal(process.env.TMPDIR, "/another-extension-temp");
});

test("missing, empty and relative XDG_CACHE_HOME fall back to ~/.cache", (t) => {
	fixture(t);
	for (const value of [undefined, "", "relative/cache"]) {
		if (value === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = value;
		const h = harness();
		h.emit("session_start");
		assert.equal(process.env.TMPDIR, join(homedir(), ".cache", "pi", "scratchpad", "session-a"));
		h.emit("session_shutdown");
	}
});

test("cache-home symlink resolves to a trusted directory", (t) => {
	const base = fixture(t);
	const target = join(base, "cache-target");
	mkdirSync(target, { mode: 0o700 });
	symlinkSync(target, process.env.XDG_CACHE_HOME);
	const h = harness();
	h.emit("session_start");
	assert.equal(process.env.TMPDIR, join(target, "pi", "scratchpad", "session-a"));
	h.emit("session_shutdown");
});

for (const id of ["../escape", ".", "..", "a/b", "", "-lead", "trail-", ".lead", "trail."]) {
	test(`rejects session id outside Pi's grammar ${JSON.stringify(id)}`, (t) => {
		fixture(t);
		const h = harness(id);
		assert.throws(() => h.emit("session_start"), /Invalid scratchpad session ID/);
		assert.equal(process.env.TMPDIR, undefined);
		assert.equal(existsSync(process.env.XDG_CACHE_HOME), false);
	});
}

// Pi permits '.', '_', and '-' inside a session id, so subagent ids like "<parent>.review" must work.
for (const id of ["a", "session-a", "01a0fffc-fed5-7136-b8c2-0c256308a5b9.review", "A.b_c-9"]) {
	test(`accepts Pi-valid session id ${JSON.stringify(id)}`, (t) => {
		fixture(t);
		const h = harness(id);
		h.emit("session_start");
		assert.equal(process.env.TMPDIR, join(process.env.XDG_CACHE_HOME, "pi", "scratchpad", id));
		h.emit("session_shutdown");
	});
}

for (const component of ["pi", "scratchpad", "session-a"]) {
	test(`rejects symlink at ${component} without creating target children`, (t) => {
		const base = fixture(t);
		const target = join(base, "target");
		mkdirSync(target, { mode: 0o700 });
		const parts = [process.env.XDG_CACHE_HOME, "pi", "scratchpad", "session-a"];
		const path = join(...parts.slice(0, parts.indexOf(component) + 1));
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		symlinkSync(target, path);
		const h = harness();
		assert.throws(() => h.emit("session_start"), /not a file or symlink/);
		assert.equal(process.env.TMPDIR, undefined);
		assert.equal(existsSync(join(target, "scratchpad")), false);
		assert.equal(existsSync(join(target, "session-a")), false);
	});
}

for (const mode of [0o755, 0o777, 0o500]) {
	test(`rejects insecure or unwritable session permissions ${mode.toString(8)}`, (t) => {
		fixture(t);
		const path = join(process.env.XDG_CACHE_HOME, "pi", "scratchpad", "session-a");
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, mode);
		const h = harness();
		assert.throws(() => h.emit("session_start"), /permissions|EACCES/);
		assert.equal(process.env.TMPDIR, undefined);
	});
}

test("initialization failure blocks shell tools, reports recovery and leaves file tools usable", async (t) => {
	fixture(t);
	mkdirSync(process.env.XDG_CACHE_HOME, { mode: 0o700 });
	writeFileSync(join(process.env.XDG_CACHE_HOME, "pi"), "not a directory");
	process.env.TMPDIR = "/original-temp";
	const h = harness();
	assert.throws(() => h.emit("session_start"), /Scratchpad initialization failed/);
	assert.equal(process.env.TMPDIR, "/original-temp");
	for (const toolName of ["bash", "powershell", "monitor"]) {
		assert.equal(h.emit("tool_call", { toolName }).block, true);
		assert.match(h.emit("tool_call", { toolName }).reason, /\/reload/);
	}
	assert.equal(h.emit("tool_call", { toolName: "read" }), undefined);
	assert.throws(() => h.emit("user_bash"), /Scratchpad initialization failed/);
	const event = { systemPromptOptions: { promptGuidelines: [] } };
	h.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.promptGuidelines[0], /unavailable/);
	await h.commands.get("scratchpad").handler("", h.ctx);
	assert.equal(h.notices[0][1], "error");
});

test("successful setup passes user bash through and /scratchpad shows TMPDIR", async (t) => {
	fixture(t);
	const h = harness();
	h.emit("session_start");
	assert.equal(h.emit("user_bash"), undefined);
	assert.equal(h.emit("tool_call", { toolName: "bash" }), undefined);
	await h.commands.get("scratchpad").handler("", h.ctx);
	assert.deepEqual(h.notices, [[`TMPDIR=${process.env.TMPDIR}`, "info"]]);
	h.emit("session_shutdown");
});
