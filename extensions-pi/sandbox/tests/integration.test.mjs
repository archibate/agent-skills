import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Offline tool-layer test: loads the real pi runtime with the sandbox and jobs extensions, then
// calls the tools. No model request is made. Requires PI_SDK_PATH (the release's dist/index.js).
const sdkPath = process.env.PI_SDK_PATH;

async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("waitFor timed out");
}

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };

test("sandboxed bash and job tools through the real pi loader", { skip: !sdkPath }, async (t) => {
	const sdk = await import(pathToFileURL(sdkPath).href);
	const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-integration-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(join(base, "scratch"));
	const saved = Object.fromEntries(["XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "PI_SCRATCHPAD_DIR", "LC_ALL"].map((k) => [k, process.env[k]]));
	Object.assign(process.env, {
		XDG_RUNTIME_DIR: base,
		XDG_CACHE_HOME: join(base, "cache"),
		PI_SCRATCHPAD_DIR: join(base, "scratch"),
		LC_ALL: "C",
	});
	const { registry } = await import("../../jobs/jobs.ts");

	let session;
	t.after(() => {
		session?.dispose?.();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
		additionalExtensionPaths: [
			new URL("../index.ts", import.meta.url).pathname,
			new URL("../../jobs/index.ts", import.meta.url).pathname,
		],
	});
	await loader.reload();
	session = (
		await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory() })
	).session;
	// The sandbox is opt-in: this test drives its behavior through the runtime flag the CLI sets.
	session.extensionRunner.setFlagValue("enable-sandbox", true);
	const errors = [];
	await session.bindExtensions({ onError: (error) => errors.push(error.error), mode: "print" });
	assert.deepEqual(errors, []);
	const notified = [];
	registry.notify = (text) => notified.push(text);

	const bash = session.getToolDefinition("bash");
	assert.ok(bash.parameters.properties.sandbox, "bash declares the sandbox parameter");
	assert.match(bash.description, /Runs in a sandbox/);
	// job_start refers to bash's schema instead of repeating it, and validates at run time.
	const jobSandbox = session.getToolDefinition("job_start").parameters.properties.sandbox;
	assert.match(jobSandbox.description, /same fields as bash's `sandbox`/);
	assert.equal(jobSandbox.properties, undefined);
	assert.match(session.getToolDefinition("job_start").description, /Runs in a sandbox/);
	assert.ok(session.getToolDefinition("job_stop"));

	const ctx = session.extensionRunner.createToolContext("sandbox-test");
	const call = (name, id, params) => session.getToolDefinition(name).execute(id, params, undefined, undefined, ctx);

	// Read-only by default, with a recovery hint on failure.
	const target = join(cwd, "out.txt");
	const denied = await call("bash", "b1", { command: `echo hi > ${target}` });
	assert.equal(denied.isError, true);
	assert.match(denied.content.at(-1).text, /sandbox\.writableLocations/);
	assert.equal(existsSync(target), false);

	// Declared access is granted.
	const allowed = await call("bash", "b2", { command: `echo hi > ${target}`, sandbox: { writableLocations: [cwd] } });
	assert.equal(allowed.isError, undefined);
	assert.equal(readFileSync(target, "utf8"), "hi\n");
	assert.equal(allowed.structuredContent.exit_code, 0);

	// No network by default, with a hint naming networkAccess.
	const offline = await call("bash", "b3", { command: "curl -sS -m 5 https://example.com" });
	assert.equal(offline.isError, true);
	assert.match(offline.content.at(-1).text, /networkAccess/);

	// The renderer shows the declaration under the command.
	const component = bash.renderCall(
		{ command: "uv run x.py", sandbox: { writableLocations: ["~/.cache/uv"], networkAccess: "fetch-only" } },
		plainTheme,
		{ state: {}, executionStarted: false, lastComponent: undefined },
	);
	const rendered = component.render(120).join("\n");
	assert.match(rendered, /\$ uv run x\.py/);
	assert.match(rendered, /⛶ rw ~\/\.cache\/uv · net fetch-only/);

	// The sandbox owns job_start's renderer; jobs has no runtime dependency on it.
	const jobStart = session.getToolDefinition("job_start");
	const jobRenderers = session.extensionRunner.resolveToolRenderers("job_start", () => ({
		renderCall: jobStart.renderCall,
		renderResult: jobStart.renderResult,
	}));
	const callArgs = {
		command: "uv run x.py",
		name: "build",
		timeout: 60,
		sandbox: { writableLocations: ["~/.cache/uv"], networkAccess: "fetch-only" },
	};
	const renderContext = () => ({ toolCallId: "render-test", state: {}, executionStarted: false, lastComponent: undefined });
	const jobRow = jobRenderers.renderCall(callArgs, plainTheme, renderContext());
	assert.deepEqual(jobRow.render(80), bash.renderCall(callArgs, plainTheme, renderContext()).render(80));
	assert.match(jobRow.render(80).join("\n"), /\$ uv run x\.py \(timeout 60s\)[\s\S]*⛶ rw ~\/\.cache\/uv · net fetch-only/);
	assert.equal(jobRenderers.renderResult, jobStart.renderResult, "job status/results are unchanged");

	// Jobs run in the same sandbox, and their files stay readable from sandboxed bash.
	const job = await call("job_start", "j1", { command: `echo job > ${join(cwd, "job.txt")}`, name: "ro" });
	await waitFor(() => existsSync(join(job.details.dir, "status")));
	assert.match(readFileSync(join(job.details.dir, "stderr"), "utf8"), /Read-only file system/);
	const inspect = await call("bash", "b4", { command: `cat ${join(job.details.dir, "stderr")}` });
	assert.match(inspect.content[0].text, /Read-only file system/);

	const rw = await call("job_start", "j2", { command: `echo job > ${join(cwd, "job.txt")}`, sandbox: { writableLocations: [cwd] } });
	await waitFor(() => existsSync(join(rw.details.dir, "status")));
	assert.equal(readFileSync(join(cwd, "job.txt"), "utf8"), "job\n");

	await assert.rejects(
		call("job_start", "j0", { command: "true", sandbox: { writable: [cwd] } }),
		/Unknown sandbox field writable/,
	);

	// job_stop stops the agent's own job without a signalling grant.
	const long = await call("job_start", "j3", { command: "sleep 60", name: "long" });
	const stopped = await call("job_stop", "s1", { id: long.details.id });
	assert.match(stopped.content[0].text, /stopped: killed by SIGTERM/);
	const again = await call("job_stop", "s2", { id: long.details.id });
	assert.match(again.content[0].text, /already finished/);

	assert.deepEqual(errors, []);
});

test("without the flag the extension stays inert", { skip: !sdkPath }, async (t) => {
	const sdk = await import(pathToFileURL(sdkPath).href);
	const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-off-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	t.after(() => rmSync(base, { recursive: true, force: true }));

	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
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
		agentDir,
		resourceLoader: loader,
		sessionManager: sdk.SessionManager.inMemory(),
	});
	t.after(() => session.dispose?.());

	const errors = [];
	await session.bindExtensions({ onError: (error) => errors.push(error.error), mode: "print" });
	assert.deepEqual(errors, []);

	// pi's built-in bash is untouched, and jobs did not redeclare job_start with a sandbox.
	const bash = session.getToolDefinition("bash");
	assert.equal(bash.parameters.properties.sandbox, undefined, "bash has no sandbox parameter");
	assert.doesNotMatch(bash.description, /Runs in a sandbox/);
	assert.equal(session.getToolDefinition("job_start").parameters.properties.sandbox, undefined);
});
