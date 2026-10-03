import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Offline tool-layer test: loads the real pi runtime and the extension, then calls the tools.
// No model request is made. Requires PI_SDK_PATH (the release's dist/index.js).
const sdkPath = process.env.PI_SDK_PATH;

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
	const { registry } = await import("../jobs.ts");
	const base = mkdtempSync(join(homedir(), ".cache", "pi-jobs-integration-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = base;

	const errors = [];
	let session;
	t.after(() => {
		session?.dispose?.();
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
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
	// Keep the test offline: a completion notification must not start a model turn.
	registry.notify = () => {};

	// Only the two in-process tools are declared; the rest is the filesystem.
	assert.ok(session.getToolDefinition("job_start"));
	assert.ok(session.getToolDefinition("job_watch"));
	for (const removed of ["job_logs", "job_wait", "job_kill", "job_signal", "job_stdin"]) {
		assert.equal(session.getToolDefinition(removed), undefined, `${removed} is no longer a tool`);
	}

	const runner = session.extensionRunner;
	const ctx = runner.createToolContext("jobs-test");
	const call = (name, toolCallId, params) =>
		session.getToolDefinition(name).execute(toolCallId, params, undefined, undefined, ctx);

	const started = await call("job_start", "s1", {
		command: "printf 'one\\n'; printf 'oops\\n' >&2; sleep 0.05; printf 'two\\n'",
		name: "quick",
	});
	assert.equal(started.isError, undefined);
	const { id, dir, pid } = started.details;
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

	// job_watch is accepted for any known job (it stops immediately once the job has exited).
	const watched = await call("job_watch", "s2", { id, timeout: 1 });
	assert.match(watched.content[0].text, /Watching/);

	// Jobs see the same session environment as the bash tool (so $PI_SESSION_ID works).
	const envJob = await call("job_start", "s10", { command: "printf '%s' \"$PI_SESSION_ID\"", name: "env" });
	await waitFor(() => existsSync(join(envJob.details.dir, "status")));
	assert.equal(readFileSync(join(envJob.details.dir, "stdout"), "utf8"), session.sessionManager.getSessionId());

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
