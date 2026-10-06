import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

test("Pi loader and session startup stay cold; loading failures are audited before human escalation", (t) => {
	const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "review-loader-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const extension = join(scratch, "extension");
	cpSync(new URL("../", import.meta.url), extension, {
		recursive: true, filter: (path) => !["node_modules", "tests"].includes(basename(path)),
	});
	mkdirSync(join(scratch, "project"));
	mkdirSync(join(scratch, "agent"));
	mkdirSync(join(scratch, ".cache"));
	// Guards execute through Pi's real Jiti loader, not native ESM import hooks.
	writeFileSync(join(extension, "auto-review.ts"), 'globalThis.__reviewerLoads.push("auto"); throw new Error("secret loader detail"); export class AutoReviewer {}');
	writeFileSync(join(extension, "modal.ts"), 'globalThis.__reviewerLoads.push("modal"); throw new Error("eager modal import"); export class ReviewModal {}');
	writeFileSync(join(extension, "manual-review.ts"), `globalThis.__reviewerLoads.push("manual"); export { createManualReviewer } from ${JSON.stringify(new URL("../manual-review.ts", import.meta.url).pathname)};`);
	const script = `
		import assert from "node:assert/strict";
		import { join } from "node:path";
		const sdk = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
		const cwd = join(process.env.HOME, "project");
		const agentDir = join(process.env.HOME, "agent");
		const theme = { fg: (_color, text) => text, bold: (text) => text };
		for (const name of [process.argv[1]]) {
			globalThis.__reviewerLoads = [];
			const loader = new sdk.DefaultResourceLoader({
				cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true,
				noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [${JSON.stringify(join(extension, "index.ts"))}],
			});
			await loader.reload();
			const { session } = await sdk.createAgentSession({
				cwd, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(),
			});
			try {
				for (const [flag, value] of [["permissions", "read-only"], ["reviewer", name]]) session.extensionRunner.setFlagValue(flag, value);
				let requests = 0;
				session.extensionRunner.getModelRegistry().streamSimple = () => { requests++; throw new Error("unexpected provider request"); };
				const shown = [];
				const uiContext = {
					theme, setStatus() {}, notify() {},
					custom: (factory) => new Promise((resolve) => {
						const modal = factory({ requestRender() {} }, theme, {}, resolve);
						shown.push(modal.render(120).join("\\n"));
						setTimeout(() => modal.handleInput("y"), 320);
					}),
				};
				const errors = [];
				await session.bindExtensions({
					mode: name === "auto" ? "print" : "tui", uiContext,
					onError: (error) => errors.push(String(error.error)),
				});
				assert.deepEqual(errors, []);
				assert.deepEqual(globalThis.__reviewerLoads, [], "registration and session startup must stay cold");
				const result = await session.extensionRunner.emitToolCall({
					type: "tool_call", toolCallId: "loading-failure", toolName: "bash",
					input: { command: "fixture", sandbox: { networkAccess: "full" } },
				});
				if (name === "auto") {
					assert.equal(result.block, true);
					assert.match(result.reason, /module could not be loaded/);
					assert.deepEqual(globalThis.__reviewerLoads, ["auto"]);
				} else {
					assert.equal(result, undefined, "human may approve an audited automatic failure");
					assert.deepEqual(globalThis.__reviewerLoads, ["auto", "manual"]);
					assert.equal(shown.length, 1);
					assert.match(shown[0], /module could not be loaded/);
					assert.doesNotMatch(shown[0], /secret/);
				}
				const records = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "sandbox-auto-review").map((entry) => entry.data);
				assert.equal(records.length, 1);
				assert.equal(records[0].toolCallId, "loading-failure");
				assert.equal(records[0].failure, "load");
				assert.equal(records[0].decision, "deny");
				assert.equal(records[0].usage.totalTokens, 0);
				assert.equal(records[0].usage.cost.total, 0);
				assert.doesNotMatch(records[0].reason, /secret/);
				assert.equal(requests, 0);
				assert.deepEqual(errors, []);
			} finally { session.dispose(); }
		}
	`;
	// A rejected dynamic import is cached within a process; each case needs a genuinely cold loader.
	for (const name of ["auto", "auto-manual"]) {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, name], {
			cwd: scratch, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
			env: {
				PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"),
				PI_SCRATCHPAD_DIR: join(scratch, "scratch"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0", JITI_FS_CACHE: "false", XDG_CACHE_HOME: join(scratch, "cache"),
				XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"),
				XDG_STATE_HOME: join(scratch, "state"), XDG_RUNTIME_DIR: join(scratch, "runtime"),
				TMPDIR: process.env.TMPDIR ?? tmpdir(), NODE_COMPILE_CACHE: join(scratch, "node-cache"),
			},
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
	}
});
