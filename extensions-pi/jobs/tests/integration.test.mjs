import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

// Offline tool-layer test: loads the real pi runtime and the extension, then calls the tools.
// No model request is made. Requires PI_SDK_PATH (the release's dist/index.js).
const sdkPath = process.env.PI_SDK_PATH;
// Keep the liveness heartbeat short so the one-shot hold surfaces it within the test.
process.env.PI_JOBS_HEARTBEAT_SECONDS = "1";

async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor timed out");
}

test("jobs tools through the real pi loader", { skip: !sdkPath }, async (t) => {
	const sdk = await import(pathToFileURL(sdkPath).href);
	const { getJob, registry } = await import("../jobs.ts");
	const base = mkdtempSync(join(homedir(), ".cache", "pi-jobs-integration-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	const previousCacheHome = process.env.XDG_CACHE_HOME;
	process.env.XDG_RUNTIME_DIR = base;
	// Jobs run in the bash sandbox, which builds its helper under the cache home.
	process.env.XDG_CACHE_HOME = join(base, "cache");

	const errors = [];
	let session;
	t.after(() => {
		session?.dispose?.();
		if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
		if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousCacheHome;
		rmSync(base, { recursive: true, force: true });
	});

	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname],
	});
	await loader.reload();

	session = (
		await sdk.createAgentSession({
			cwd,
			agentDir,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(),
		})
	).session;
	await session.bindExtensions({ onError: (error) => errors.push(error.error), mode: "print" });
	assert.deepEqual(errors, []);
	// Keep the test offline: collect notifications instead of letting them start a model turn.
	const notified = [];
	registry.notify = (text) => notified.push(text);

	// Only the in-process tools are declared; the rest is the filesystem.
	assert.ok(session.getToolDefinition("job_start"));
	assert.ok(session.getToolDefinition("job_watch"));
	assert.ok(session.getToolDefinition("job_stop"));
	// Without the sandbox extension, job_start has no sandbox parameter and runs jobs unsandboxed.
	assert.equal(session.getToolDefinition("job_start").parameters.properties.sandbox, undefined);
	for (const removed of ["job_logs", "job_wait", "job_kill", "job_signal", "job_stdin"]) {
		assert.equal(session.getToolDefinition(removed), undefined, `${removed} is no longer a tool`);
	}

	const runner = session.extensionRunner;
	const messageRenderer = runner.getMessageRenderer("job");
	assert.equal(typeof messageRenderer, "function");
	const notificationText = '[job render "preview"] exit 0\n' + Array.from({ length: 20 }, (_, i) => `output ${i + 1}`).join("\n");
	sdk.initTheme("dark"); // No TUI or theme watcher: exercise only the transcript component.
	const notification = new sdk.CustomMessageComponent(
		{ role: "custom", customType: "job", content: notificationText, display: true, timestamp: Date.now() },
		messageRenderer,
	);
	const collapsedLines = notification.render(80);
	assert.ok(collapsedLines.length <= 10, "custom notifications start collapsed like tool output");
	const click = () => notification.handleMouse({
		type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2,
		width: 80, height: notification.render(80).length, shift: false, alt: false, ctrl: false,
	});
	const clicked = click();
	assert.equal(clicked.handled, true, "the host routes the click to the notification renderer");
	assert.equal(clicked.render, true, "the mouse event requests a redraw");
	assert.ok(notification.render(80).length > collapsedLines.length);
	notification.invalidate();
	assert.ok(notification.render(80).length > collapsedLines.length, "local expansion survives a host rebuild");
	notification.setOutputPad(2);
	assert.ok(notification.render(80).length > collapsedLines.length, "padding changes preserve local expansion");
	notification.setOutputPad(1);
	click();
	assert.deepEqual(notification.render(80), collapsedLines, "a second click collapses the notification");
	notification.setExpanded(true);
	assert.ok(notification.render(80).length > collapsedLines.length, "the regular expansion toggle reveals the logs");
	notification.setExpanded(false);
	assert.deepEqual(notification.render(80), collapsedLines);

	// Tool renderers still use Pi's own result region and click expansion, with no terminal I/O.
	for (const [name, args, details] of [
		["job_start", { command: "build", name: "build" }, { id: "render", pid: 12345, dir: "/private/logs" }],
		["job_watch", { id: "render", pattern: "error" }, { id: "render" }],
		["job_stop", { id: "render" }, { id: "render", summary: "stopped: killed by SIGTERM" }],
	]) {
		const view = new sdk.ToolExecutionComponent(name, `render-${name}`, args, {}, session.getToolDefinition(name), { requestRender() {} }, cwd);
		const fullText = "full result details\nprivate log path and status";
		view.updateResult({ content: [{ type: "text", text: fullText }], details });
		const lines = () => view.render(80).map(stripVTControlCharacters).join("\n");
		assert.doesNotMatch(lines(), /private log path/);
		const clickResult = () => {
			const rendered = view.render(80).map(stripVTControlCharacters);
			return view.handleMouse({ type: "click", button: "left", x: 2, y: rendered.findIndex((line) => line.includes("→")),
				screenX: 2, screenY: 2, width: 80, height: rendered.length, shift: false, alt: false, ctrl: false });
		};
		assert.equal(clickResult().handled, true);
		assert.match(lines(), /private log path/);
		assert.equal(clickResult().handled, true);
		assert.doesNotMatch(lines(), /private log path/);
	}

	const ctx = runner.createToolContext("jobs-test");
	const call = (name, toolCallId, params) =>
		session.getToolDefinition(name).execute(toolCallId, params, undefined, undefined, ctx);

	const started = await call("job_start", "s1", {
		command: "printf 'one\\n'; printf 'oops\\n' >&2; sleep 0.05; printf 'two\\n'",
		name: "quick",
	});
	assert.equal(started.isError, undefined);
	assert.match(started.content[0].text, /You will be notified when it exits/);
	const { id, dir, pid } = started.details;
	const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
	for (const [toolName, expected] of [
		["job_watch", `job watch ${id} "quick" · 600s`],
		["job_stop", `job stop ${id} "quick" · SIGTERM`],
	]) {
		const row = session.getToolDefinition(toolName).renderCall({ id }, plainTheme, { state: {} });
		assert.equal(row.render(120).map(stripVTControlCharacters).map((line) => line.trimEnd()).join("\n"), expected);
	}
	assert.equal(typeof id, "string");
	assert.equal(dir, join(base, "pi-jobs", id));
	assert.equal(statSync(dir).mode & 0o777, 0o700);

	// Companion files are the API.
	const pgidPath = join(dir, "pgid");
	const commandPath = join(dir, "command");
	assert.equal(existsSync(pgidPath), true);
	assert.equal(readFileSync(pgidPath, "utf8").trim(), String(pid));
	assert.match(readFileSync(commandPath, "utf8"), /printf/);

	await waitFor(() => existsSync(join(dir, "status")));
	assert.match(readFileSync(join(dir, "stdout"), "utf8"), /one[\s\S]*two/);
	assert.match(readFileSync(join(dir, "stderr"), "utf8"), /oops/);
	assert.match(readFileSync(join(dir, "status"), "utf8"), /exit 0/);

	// One-shot modes hold settlement until pending jobs finish, so completion can trigger a turn.
	const slow = await call("job_start", "s3", { command: "sleep 0.4", name: "slow" });
	const holdStart = Date.now();
	const settle = await session.extensionRunner.emitBoundary({ type: "agent_before_settle" }, () => ({}));
	assert.equal(settle.continue, true);
	assert.ok(Date.now() - holdStart >= 200, "settlement was held until the job exited");
	await waitFor(() => existsSync(join(slow.details.dir, "status")));

	// A job that outlives its heartbeat interval surfaces a per-job liveness nudge instead of hanging.
	notified.length = 0;
	const stuck = await call("job_start", "s8", { command: "sleep 30", name: "stuck" });
	const hbStart = Date.now();
	const hb = await session.extensionRunner.emitBoundary({ type: "agent_before_settle" }, () => ({}));
	assert.equal(hb.continue, true);
	assert.ok(Date.now() - hbStart >= 800, "settlement held until the heartbeat interval elapsed");
	assert.ok(
		notified.some((text) => /Liveness check/.test(text) && /stuck/.test(text)),
		`expected a liveness heartbeat: ${notified.join(" | ")}`,
	);
	// The nudge leaves the job alone; kill it so the process can settle and the test moves on.
	const stuckJob = getJob(stuck.details.id);
	stuckJob.kill();
	await stuckJob.done;
	await new Promise((resolve) => setTimeout(resolve, 50));

	// A watched job notifies exactly once: the live watch owns the exit message, and the completion
	// handler defers to it instead of delivering a second summary.
	notified.length = 0;
	const watchedJob = await call("job_start", "s4", { command: "sleep 0.2; printf 'done\\n'", name: "watched" });
	await call("job_watch", "s5", { id: watchedJob.details.id, timeout: 5 });
	await waitFor(() => existsSync(join(watchedJob.details.dir, "status")));
	await waitFor(() => notified.length >= 1);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(notified.length, 1, `expected one notification, got ${notified.length}: ${notified.join(" | ")}`);
	assert.match(notified[0], /watched/);

	// Replay: output produced before the watch attached is still delivered.
	notified.length = 0;
	const early = await call("job_start", "s6", {
		command: "printf 'early-1\\nearly-2\\n'; sleep 0.4; printf 'late\\n'",
		name: "replay",
	});
	await new Promise((resolve) => setTimeout(resolve, 150)); // let the early lines land before watching
	await call("job_watch", "s7", { id: early.details.id, timeout: 5 });
	await waitFor(() => existsSync(join(early.details.dir, "status")));
	await waitFor(() => notified.some((text) => /late/.test(text)));
	const replayed = notified.join("\n");
	assert.match(replayed, /early-1/);
	assert.match(replayed, /early-2/);
	assert.match(replayed, /late/);

	// job_watch is accepted for any known job (it stops immediately once the job has exited).
	const watched = await call("job_watch", "s2", { id, timeout: 1 });
	assert.match(watched.content[0].text, /Watching/);

	// Jobs see the same session environment as the bash tool (so $PI_SESSION_ID works).
	const envJob = await call("job_start", "s10", { command: "printf '%s' \"$PI_SESSION_ID\"", name: "env" });
	await waitFor(() => existsSync(join(envJob.details.dir, "status")));
	assert.equal(readFileSync(join(envJob.details.dir, "stdout"), "utf8"), session.sessionManager.getSessionId());

	// Execution supplies truthful display-only stop outcomes without changing the agent-facing text.
	const stoppable = await call("job_start", "s11", { command: "sleep 30", name: "stoppable" });
	const stopped = await call("job_stop", "s12", { id: stoppable.details.id });
	assert.match(stopped.content[0].text, /stopped: killed by SIGTERM/);
	assert.equal(stopped.details.summary, "stopped: killed by SIGTERM");
	const alreadyStopped = await call("job_stop", "s13", { id: stoppable.details.id });
	assert.match(alreadyStopped.content[0].text, /already finished: killed by SIGTERM/);
	assert.equal(alreadyStopped.details.summary, "already finished: killed by SIGTERM");

	// bash stays native, but a missing timeout is filled in, and the timeout error routes to jobs.
	const toolCall = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "sleep 200" } };
	assert.equal(await runner.emitToolCall(toolCall), undefined);
	assert.equal(toolCall.input.timeout, 120);
	const timedOut = await runner.emitToolResult({
		type: "tool_result",
		toolCallId: "t2",
		toolName: "bash",
		input: { command: "sleep 200" },
		content: [{ type: "text", text: "Command timed out after 120 seconds" }],
		isError: true,
	});
	assert.match(timedOut.content.at(-1).text, /job_start/);

	assert.deepEqual(errors, []);
});
