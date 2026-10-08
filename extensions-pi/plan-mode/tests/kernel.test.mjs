import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { f, setup } from "./support.mjs";

after(f.cleanup);

test("real kernel sandbox: retained plan scratchpad writable, isolated workspace read-only", {
	skip: process.env.PI_PLAN_KERNEL_TEST !== "1", timeout: 75000,
}, async () => {
	assert.equal(process.env.PI_SANDBOX, undefined, "Run this probe outside an existing sandbox");
	const keys = ["HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "PI_SCRATCHPAD_DIR"];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	const home = join(f.scratch, "private-home");
	const runtime = join(f.scratch, "private-runtime");
	mkdirSync(home, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
	Object.assign(process.env, { HOME: home, XDG_CACHE_HOME: join(f.scratch, "private-cache"), XDG_RUNTIME_DIR: runtime });
	delete process.env.PI_SCRATCHPAD_DIR;
	const { default: registerSandbox } = await f.loadSandbox("index.ts");
	const { execShell } = await f.loadSandbox("sandbox.ts");
	const { landlockExec } = await f.loadSandbox("host.ts");
	let h, prepared;
	try {
		h = await setup({ before: [registerSandbox], flag: true, flags: { permissions: "read-only" } });
		await landlockExec(); // One small helper build, owned cache only; wait before cleanup.
		let provider;
		h.api.events.emit("archibate.sandbox:get", (value) => { provider = value; });
		prepared = await provider.prepare({ processAccess: "disable" }, h.cwd);
		const env = prepared.env({ PATH: "/usr/bin:/bin", HOME: home });
		assert.equal(env.PI_SCRATCHPAD_DIR, dirname(h.plan().path));
		assert.ok(env.PI_SCRATCHPAD_DIR.startsWith(f.scratch + "/"));
		let output = "";
		const result = await execShell(prepared.shell({ shell: "/bin/bash", args: ["-c"] }), [
			"set -eu",
			'printf scratch > "$PI_SCRATCHPAD_DIR/kernel-probe.txt"',
			'printf private > "$TMPDIR/kernel-probe.txt"',
			'if (printf forbidden > "$PWD/blocked.txt") 2>/dev/null; then exit 91; fi',
			"printf 'kernel isolation passed\\n'",
		].join("\n"), h.cwd, { env, timeout: 3, reapGroup: true, onData: (data) => { output += data.toString(); } });
		assert.equal(result.exitCode, 0, output);
		assert.match(output, /kernel isolation passed/);
		assert.equal(readFileSync(join(env.PI_SCRATCHPAD_DIR, "kernel-probe.txt"), "utf8"), "scratch");
		assert.equal(existsSync(join(h.cwd, "blocked.txt")), false);
	} finally {
		await prepared?.dispose();
		h?.close();
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});
