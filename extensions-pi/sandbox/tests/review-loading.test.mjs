import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Implementation tests import the classes directly; a cold child verifies the real import graph.
test("registration stays cold and first use loads only the selected reviewer", (t) => {
	const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "review-loading-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const script = `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const loaded = new Set();
		const implementations = ["auto-review.ts", "review-tools.ts", "manual-review.ts", "modal.ts"];
		registerHooks({ load(url, context, next) {
			for (const name of implementations) if (url.endsWith("/" + name)) loaded.add(name);
			return next(url, context);
		} });
		const { createReviewer } = await import(${JSON.stringify(new URL("../review.ts", import.meta.url).href)});
		const { default: sandboxExtension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
		for (const enabled of [false, true]) sandboxExtension({
			registerTool() {}, registerFlag() {}, registerToolRenderer() {}, registerCommand() {}, on() {},
			getFlag: (name) => name === "enable-sandbox" ? enabled : undefined,
			events: { on() {} },
		});
		for (const name of ["deny", "manual", "auto", "auto-manual"]) {
			const reviewer = createReviewer(name, "tui");
			assert.equal(reviewer.name, name);
			reviewer.dispose?.();
		}
		assert.deepEqual([...loaded], [], "registration must not import reviewer implementations");
		assert.throws(() => createReviewer("auto", "print", { model: "invalid" }), /provider\\/model/);
		assert.deepEqual([...loaded], [], "invalid configuration must fail without loading");
		const auto = createReviewer("auto", "print");
		const result = await auto.review({}, { modelRegistry: { find: () => undefined } });
		assert.equal(result.kind, "deny");
		assert.match(result.feedback, /Model or credentials unavailable/);
		assert.ok(loaded.has("auto-review.ts"));
		assert.ok(loaded.has("review-tools.ts"));
		assert.equal(loaded.has("modal.ts"), false);
		auto.dispose();
		const manual = createReviewer("manual", "tui");
		const controller = new AbortController();
		const request = { toolName: "bash", input: { command: "fixture" }, cwd: "/work", subject: "bash", excess: [] };
		const verdict = await manual.review(request, {
			mode: "tui", signal: controller.signal,
			ui: { custom: (factory) => new Promise((resolve) => {
				factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, resolve);
				queueMicrotask(() => controller.abort());
			}) },
		});
		assert.equal(verdict.kind, "deny");
		assert.equal(verdict.cancelled, true);
		assert.ok(loaded.has("manual-review.ts"));
		assert.ok(loaded.has("modal.ts"));
		manual.dispose();
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: scratch, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
		env: {
			PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: scratch, PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", XDG_CACHE_HOME: join(scratch, "cache"),
			XDG_RUNTIME_DIR: join(scratch, "runtime"), NODE_COMPILE_CACHE: join(scratch, "node-cache"),
		},
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
});
