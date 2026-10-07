import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import costs from "../index.ts";
import jobs from "../../jobs/index.ts";
import { getJob, registry } from "../../jobs/jobs.ts";
import { SUMMARY } from "../presentation.ts";

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

test("job_start passes parent identity, real child processes self-register and resume", { timeout: 15000 }, async (t) => {
	assert.ok(process.env.PI_SCRATCHPAD_DIR);
	const root = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR, "cost-process-test-"));
	const previousRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	const tools = new Map(), handlers = new Map();
	const notices = [];
	const parent = SessionManager.create(root, join(root, "sessions"), { id: "parent" });
	parent.appendMessage({ role: "user", content: "offline fixture", timestamp: Date.now() });
	const ctx = { cwd: root, sessionManager: parent, hasUI: true, mode: "tui", ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
	costs({ on: (name, fn) => handlers.set(name, fn), appendEntry: (type, data) => parent.appendCustomEntry(type, data) });
	handlers.get("session_start")({}, ctx);
	jobs({ on() {}, registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {} });
	registry.notify = () => {}; // Notifications must not trigger a real agent/model turn.
	t.after(() => {
		handlers.get("session_shutdown")({}, ctx);
		if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntime;
		rmSync(root, { recursive: true, force: true });
	});
	const loader = new URL("../../rmb-cost/tests/pi-loader.mjs", import.meta.url).pathname;
	const script = new URL("./child.mjs", import.meta.url).pathname;
	const child = SessionManager.forkFrom(parent.getSessionFile(), root, join(root, "sessions"), { id: "parent.child" });
	const command = [process.execPath, "--import", loader, script, child.getSessionFile()].map(quote).join(" ");
	for (let i = 1; i <= 2; i++) {
		const result = await tools.get("job_start").execute(`cost-${i}`, { command, timeout: 5 }, undefined, undefined, ctx);
		const job = getJob(result.details.id);
		job.keepAlive();
		await job.done;
		assert.match(readFileSync(join(job.dir, "status"), "utf8"), /exit 0/);
		assert.equal(readFileSync(join(job.dir, "stderr"), "utf8"), "");
		const deadline = Date.now() + 2000;
		while (parent[SUMMARY]().costUSD !== 0.5 * i && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(parent[SUMMARY](), { costUSD: 0.5 * i, count: 1 });
	}
	assert.deepEqual(notices, []);

	// An in-memory caller must clear an inherited attribution rather than billing a grandparent.
	const previousParent = process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
	const previousFile = process.env.PI_SESSION_FILE;
	process.env.PI_SUBAGENT_PARENT_SESSION_FILE = parent.getSessionFile();
	process.env.PI_SESSION_FILE = parent.getSessionFile();
	try {
		const memoryCtx = { ...ctx, sessionManager: SessionManager.inMemory(root) };
		const result = await tools.get("job_start").execute("memory", {
			command: "printf '%s:%s' \"${PI_SUBAGENT_PARENT_SESSION_FILE-unset}\" \"${PI_SESSION_FILE-unset}\"", timeout: 2,
		}, undefined, undefined, memoryCtx);
		const job = getJob(result.details.id);
		job.keepAlive();
		await job.done;
		assert.equal(readFileSync(join(job.dir, "stdout"), "utf8"), "unset:unset");
	} finally {
		if (previousParent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
		else process.env.PI_SUBAGENT_PARENT_SESSION_FILE = previousParent;
		if (previousFile === undefined) delete process.env.PI_SESSION_FILE;
		else process.env.PI_SESSION_FILE = previousFile;
	}
});
