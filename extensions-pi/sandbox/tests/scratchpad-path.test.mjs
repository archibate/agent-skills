import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionScratchpad } from "../scratchpad-path.ts";

function fixture(t) {
	const cache = mkdtempSync(join(tmpdir(), "pi-sandbox-scratchpad-"));
	t.after(() => rmSync(cache, { recursive: true, force: true }));
	return { cache, env: { XDG_CACHE_HOME: cache, PI_SCRATCHPAD_DIR: "/inherited" }, path: join(cache, "pi/scratchpad/current-session") };
}

test("allocated current-session storage takes precedence over an inherited scratchpad", (t) => {
	const f = fixture(t);
	assert.equal(sessionScratchpad("current-session", f.env), "/inherited");
	mkdirSync(f.path, { recursive: true, mode: 0o700 });
	assert.equal(sessionScratchpad("current-session", f.env), f.path);
	delete f.env.PI_SCRATCHPAD_DIR;
	assert.equal(sessionScratchpad("current-session", f.env), f.path);
	assert.equal(sessionScratchpad("another-session", f.env), undefined);
});

test("scratchpad lookup neither creates directories nor accepts a traversal ID", (t) => {
	const f = fixture(t);
	assert.equal(sessionScratchpad(undefined, f.env), "/inherited");
	assert.throws(() => sessionScratchpad("../other", f.env), /Invalid/);
	assert.equal(sessionScratchpad("current-session", { XDG_CACHE_HOME: join(f.cache, "missing") }), undefined);
});

test("an insecure or symlinked allocated scratchpad fails closed", (t) => {
	const f = fixture(t);
	mkdirSync(f.path, { recursive: true, mode: 0o700 });
	chmodSync(f.path, 0o777);
	assert.throws(() => sessionScratchpad("current-session", f.env), /Unsafe/);
	rmSync(f.path, { recursive: true });
	const target = join(f.cache, "elsewhere");
	mkdirSync(target, { mode: 0o700 });
	symlinkSync(target, f.path);
	assert.throws(() => sessionScratchpad("current-session", f.env), /Unsafe/);
});
