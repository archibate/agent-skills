import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitControlPaths } from "../host.ts";

function fixture(t) {
	const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-host-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	return base;
}

test("git protection discovers only existing paths beneath writable locations", (t) => {
	const base = fixture(t);
	const repo = join(base, "repo");
	mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
	writeFileSync(join(repo, ".git", "config"), "[core]\n");
	const plain = join(base, "plain");
	mkdirSync(plain);
	assert.deepEqual(gitControlPaths([repo, plain]), [join(repo, ".git", "hooks"), join(repo, ".git", "config")]);
});

test("file grants and file-shaped .git markers have no invented git children", (t) => {
	const base = fixture(t);
	const file = join(base, "file");
	writeFileSync(file, "before\n");
	const worktree = join(base, "worktree");
	mkdirSync(worktree);
	writeFileSync(join(worktree, ".git"), "gitdir: /missing/gitdir\n");
	assert.deepEqual(gitControlPaths([file, worktree, join(base, "missing")]), []);
});
