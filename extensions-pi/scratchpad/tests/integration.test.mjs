import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { registry as jobsRegistry } from "../../jobs/jobs.ts";

// Explicit path keeps the tests tied to the Pi version being checked, without installing dependencies.
const sdkPath = process.env.PI_SDK_PATH;
const here = dirname(fileURLToPath(import.meta.url));

test("real Pi loader, jobs, user bash, prompt, reload, new, resume and fork", { skip: !sdkPath }, async (t) => {
	const sdkUrl = pathToFileURL(resolve(sdkPath));
	const sdk = await import(sdkUrl.href);
	const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", sdkUrl).href);
	const base = mkdtempSync(join(homedir(), ".cache", "pi-scratchpad-integration-"));
	const savedTmpdir = process.env.TMPDIR;
	const savedCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(base, "cache");
	process.env.TMPDIR = base;
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const errors = [];
	const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
		const services = await sdk.createAgentSessionServices({
			cwd, agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [resolve(here, "../index.ts"), resolve(here, "../../jobs/index.ts")],
			},
		});
		return {
			...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services, diagnostics: services.diagnostics,
		};
	};
	let runtime;
	t.after(async () => {
		try { await runtime?.dispose(); }
		finally {
			if (savedTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = savedTmpdir;
			if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = savedCache;
			rmSync(base, { recursive: true, force: true });
		}
	});

	runtime = await sdk.createAgentSessionRuntime(createRuntime, {
		cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, join(base, "sessions")),
	});
	const bind = async (session) => {
		await session.bindExtensions({ onError: (error) => errors.push(error.error), mode: "print" });
		// Keep the test offline: job completion must not start a model turn.
		jobsRegistry.notify = () => {};
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	assert.deepEqual(errors, []);
	assert.equal(runtime.session.extensionRunner.getExtensionPaths().length, 2);
	const first = process.env.TMPDIR;
	assert.equal(first, join(base, "cache", "pi", "scratchpad", runtime.session.sessionManager.getSessionId()));
	writeFileSync(join(first, "result.txt"), "retained");

	const runner = runtime.session.extensionRunner;
	const before = await runner.emitBeforeAgentStart("fixture", undefined, { cwd, promptGuidelines: ["Existing rule"] });
	const prompt = buildSystemPrompt(before.systemPromptOptions);
	assert.match(prompt, /Session scratchpad:/);
	assert.equal(prompt.includes(JSON.stringify(first)), true);
	assert.match(prompt, /In bash, "\$TMPDIR" is a shortcut/);
	assert.match(prompt, /absolute path with read\/write\/edit/);
	assert.match(prompt, /do not expand environment variables/);
	assert.match(prompt, /Existing rule/);

	const definition = runtime.session.getToolDefinition("bash");
	const tool = await definition.execute("fixture", { command: 'printf "%s\\n" "$TMPDIR" "$PWD"; mktemp' }, undefined, undefined, runner.createToolContext("fixture"));
	assert.equal(tool.isError, undefined);
	const [tempEnv, workdir, tempFile] = tool.structuredContent.output.trim().split("\n");
	assert.equal(tempEnv, first);
	assert.equal(workdir, cwd);
	assert.equal(dirname(tempFile), first);

	// The advertised absolute path works directly with all three file tools.
	const filePath = join(first, "file-tool-result.txt");
	const executeFileTool = (name, params) => runtime.session.getToolDefinition(name).execute(
		`fixture-${name}`, params, undefined, undefined, runner.createToolContext(`fixture-${name}`),
	);
	await executeFileTool("write", { path: filePath, content: "before" });
	const initialRead = await executeFileTool("read", { path: filePath });
	assert.equal(initialRead.content[0].text, "before");
	await executeFileTool("edit", { path: filePath, edits: [{ oldText: "before", newText: "after" }] });
	const editedRead = await executeFileTool("read", { path: filePath });
	assert.equal(editedRead.content[0].text, "after");

	const intercept = await runner.emitUserBash({ type: "user_bash", command: 'printf "%s" "$TMPDIR"', excludeFromContext: true, cwd });
	assert.equal(intercept, undefined);
	const userBash = await runtime.session.executeBash('printf "%s" "$TMPDIR"', undefined, { excludeFromContext: true });
	assert.equal(userBash.exitCode, 0);
	assert.equal(userBash.output, first);

	// Pi's own overflow logs should also use the new process-local TMPDIR.
	const overflow = await definition.execute("overflow", { command: "printf '%060000d' 0" }, undefined, undefined, runner.createToolContext("overflow"));
	assert.equal(overflow.isError, undefined);
	assert.equal(dirname(overflow.details.fullOutputPath), first);

	// Background jobs must inherit the scratchpad TMPDIR too.
	const jobStart = runtime.session.getToolDefinition("job_start");
	const started = await jobStart.execute("fixture-job-start", { command: "printf 'job-output\\n'", name: "tmpdir" }, undefined, undefined, runner.createToolContext("fixture-job-start"));
	assert.equal(started.isError, undefined);
	const logPath = join(started.details.dir, "stdout");
	assert.equal(logPath.startsWith(join(first, "pi-jobs") + "/"), true);
	const statusPath = join(started.details.dir, "status");
	for (let i = 0; i < 300 && !existsSync(statusPath); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(readFileSync(logPath, "utf8").includes("job-output"), true);

	const userEntry = runtime.session.sessionManager.appendMessage({ role: "user", content: "offline fixture", timestamp: Date.now() });
	const firstSession = runtime.session.sessionFile;
	assert.ok(firstSession);
	await runtime.session.reload();
	assert.equal(process.env.TMPDIR, first);
	assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "retained");
	assert.deepEqual(errors, []);

	await runtime.newSession();
	assert.notEqual(process.env.TMPDIR, first);
	assert.equal(process.env.TMPDIR, join(base, "cache", "pi", "scratchpad", runtime.session.sessionManager.getSessionId()));
	const newBefore = await runtime.session.extensionRunner.emitBeforeAgentStart("fixture", undefined, { cwd });
	const newPrompt = buildSystemPrompt(newBefore.systemPromptOptions);
	assert.equal(newPrompt.includes(JSON.stringify(process.env.TMPDIR)), true);
	assert.equal(newPrompt.includes(first), false);
	await runtime.switchSession(firstSession);
	assert.equal(process.env.TMPDIR, first);
	assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "retained");
	await runtime.fork(userEntry, { position: "at" });
	assert.notEqual(process.env.TMPDIR, first);
	assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "retained");
	assert.deepEqual(errors, []);

	await runtime.dispose();
	runtime = undefined;
	assert.equal(process.env.TMPDIR, base);
});
