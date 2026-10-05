import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BlobStore, applyRestore, countChangedLines, isRestorableFile, planRestore, summarizeCheckpoints, toWorkspaceRelative } from "../store.ts";

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-rewind-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("toWorkspaceRelative accepts paths inside the working directory only", () => {
	const cwd = "/home/user/project";
	assert.equal(toWorkspaceRelative(cwd, "src/a.ts"), "src/a.ts");
	assert.equal(toWorkspaceRelative(cwd, "./src/a.ts"), "src/a.ts");
	assert.equal(toWorkspaceRelative(cwd, "/home/user/project/b.ts"), "b.ts");
	assert.equal(toWorkspaceRelative(cwd, "../outside.ts"), undefined);
	assert.equal(toWorkspaceRelative(cwd, "/etc/passwd"), undefined);
	assert.equal(toWorkspaceRelative(cwd, "/home/user/project-evil/b.ts"), undefined);
});

test("isRestorableFile rejects symlinks, hard links, directories, and missing paths", (t) => {
	const dir = tempDir(t);
	writeFileSync(join(dir, "plain.txt"), "plain");
	writeFileSync(join(dir, "target.txt"), "target");
	symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
	linkSync(join(dir, "target.txt"), join(dir, "hard.txt"));

	assert.equal(isRestorableFile(join(dir, "plain.txt")), true);
	assert.equal(isRestorableFile(join(dir, "link.txt")), false);
	assert.equal(isRestorableFile(join(dir, "hard.txt")), false);
	assert.equal(isRestorableFile(join(dir, "missing.txt")), false);
	assert.equal(isRestorableFile(dir), false);
});

test("BlobStore deduplicates content and garbage-collects unreferenced blobs", (t) => {
	const blobs = new BlobStore(tempDir(t));
	const first = blobs.put(Buffer.from("hello"));
	const second = blobs.put(Buffer.from("hello"));
	const other = blobs.put(Buffer.from("world"));

	assert.equal(first, second);
	assert.notEqual(first, other);
	assert.deepEqual(blobs.get(first).toString(), "hello");
	assert.equal(blobs.get("0".repeat(64)), undefined);
	assert.equal(blobs.sizeOf(first), 5);
	assert.equal(blobs.sizeOf("0".repeat(64)), 0);

	assert.equal(blobs.gc(new Set([first])), 1);
	assert.deepEqual(blobs.hashes().sort(), [first]);
});

test("planRestore rolls every file back to its earliest edit at or after the target", () => {
	const checkpoint = (seq, files) => ({ entryId: `e${seq}`, seq, timestamp: seq, files });
	const a1 = { path: "a.txt", hash: "a1", existed: true };
	const a2 = { path: "a.txt", hash: "a2", existed: true };
	const a3 = { path: "a.txt", hash: "a3", existed: true };
	const bCreated = { path: "b.txt", hash: "", existed: false };
	const checkpoints = [
		checkpoint(1, [a1]),
		checkpoint(2, [a2, bCreated]),
		checkpoint(3, [a3]),
	];

	const fromTwo = planRestore(checkpoints, checkpoints[1]);
	assert.deepEqual([...fromTwo.keys()].sort(), ["a.txt", "b.txt"]);
	assert.equal(fromTwo.get("a.txt").hash, "a2");
	assert.equal(fromTwo.get("b.txt").existed, false);

	const fromOne = planRestore(checkpoints, checkpoints[0]);
	assert.equal(fromOne.get("a.txt").hash, "a1");
});

test("applyRestore rewrites modified files and deletes created ones", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	const initial = Buffer.from("initial contents");
	const hash = blobs.put(initial);

	// Current (post-edit) working tree.
	writeFileSync(join(cwd, "a.txt"), "modified contents");
	writeFileSync(join(cwd, "b.txt"), "created by pi");
	writeFileSync(join(cwd, "untouched.txt"), "leave me");

	const plan = new Map([
		["a.txt", { path: "a.txt", hash, existed: true }],
		["b.txt", { path: "b.txt", hash: "", existed: false }],
	]);
	const report = applyRestore(cwd, plan, blobs);

	assert.deepEqual(report.restored, ["a.txt"]);
	assert.deepEqual(report.deleted, ["b.txt"]);
	assert.deepEqual(report.skipped, []);
	assert.deepEqual(report.missing, []);
	assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "initial contents");
	assert.equal(existsSync(join(cwd, "b.txt")), false);
	assert.equal(readFileSync(join(cwd, "untouched.txt"), "utf8"), "leave me");
});

test("applyRestore skips symlinks and reports missing blobs", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	writeFileSync(join(cwd, "target.txt"), "target");
	symlinkSync(join(cwd, "target.txt"), join(cwd, "link.txt"));

	const plan = new Map([
		["link.txt", { path: "link.txt", hash: blobs.put(Buffer.from("x")), existed: true }],
		["gone.txt", { path: "gone.txt", hash: "f".repeat(64), existed: true }],
	]);
	const report = applyRestore(cwd, plan, blobs);

	assert.deepEqual(report.skipped, ["link.txt"]);
	assert.deepEqual(report.missing, ["gone.txt"]);
	assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "target");
});

test("applyRestore leaves out-of-cwd targets alone", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	const plan = new Map([["../escape.txt", { path: "../escape.txt", hash: blobs.put(Buffer.from("x")), existed: true }]]);

	const report = applyRestore(cwd, plan, blobs);
	assert.deepEqual(report.skipped, ["../escape.txt"]);
});

test("applyRestore recreates a file deleted after the checkpoint", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	const hash = blobs.put(Buffer.from("restored"));
	mkdirSync(join(cwd, "nested"));
	const plan = new Map([["nested/file.txt", { path: "nested/file.txt", hash, existed: true }]]);

	const report = applyRestore(cwd, plan, blobs);
	assert.deepEqual(report.restored, ["nested/file.txt"]);
	assert.equal(readFileSync(join(cwd, "nested/file.txt"), "utf8"), "restored");
});

test("applyRestore reports files whose pre-image was never captured", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	writeFileSync(join(cwd, "big.bin"), "current");

	const plan = new Map([["big.bin", { path: "big.bin", hash: "", existed: true, skipped: "too-large" }]]);
	const report = applyRestore(cwd, plan, blobs);

	assert.deepEqual(report.unrestorable, ["big.bin"]);
	assert.deepEqual(report.restored, []);
	assert.equal(readFileSync(join(cwd, "big.bin"), "utf8"), "current");
});

test("summarizeCheckpoints marks uncaptured files without inventing counts", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	const checkpoint = {
		entryId: "u1",
		seq: 1,
		timestamp: 1,
		files: [
			{ path: "a.txt", hash: blobs.put(Buffer.from("one\n")), existed: true },
			{ path: "big.bin", hash: "", existed: true, skipped: "too-large" },
		],
	};
	writeFileSync(join(cwd, "a.txt"), "one\ntwo\n");
	writeFileSync(join(cwd, "big.bin"), "whatever");

	const stats = summarizeCheckpoints(cwd, [checkpoint], blobs);
	assert.deepEqual(stats.get(checkpoint).files, [
		{ path: "a.txt", added: 1, removed: 0 },
		{ path: "big.bin", added: 0, removed: 0, skipped: true },
	]);
});

test("countChangedLines counts added and removed lines", () => {
	assert.deepEqual(countChangedLines("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
	assert.deepEqual(countChangedLines("", "x\ny\n"), { added: 2, removed: 0 });
	assert.deepEqual(countChangedLines("x\ny\n", ""), { added: 0, removed: 2 });
	assert.deepEqual(countChangedLines("same\n", "same\n"), { added: 0, removed: 0 });
	assert.deepEqual(countChangedLines("a\nb\nc\nd\n", "a\nd\n"), { added: 0, removed: 2 });
});

test("summarizeCheckpoints attributes each prompt's line changes", (t) => {
	const cwd = tempDir(t);
	const blobs = new BlobStore(join(cwd, ".store"));
	// Prompt 1 changes a.txt, prompt 2 removes its last line and creates b.txt.
	const before1 = { path: "a.txt", hash: blobs.put(Buffer.from("one\ntwo\n")), existed: true };
	const after1 = blobs.put(Buffer.from("one\nTWO\nthree\n"));
	const checkpoint1 = {
		entryId: "u1",
		seq: 1,
		timestamp: 1,
		files: [before1, { path: "b.txt", hash: "", existed: false }],
	};
	const checkpoint2 = {
		entryId: "u2",
		seq: 2,
		timestamp: 2,
		files: [{ path: "a.txt", hash: after1, existed: true }],
	};
	writeFileSync(join(cwd, "a.txt"), "one\nTWO\n");
	writeFileSync(join(cwd, "b.txt"), "hello\n");

	// Order of the input array must not matter; the summary is chronological.
	const stats = summarizeCheckpoints(cwd, [checkpoint2, checkpoint1], blobs);

	const first = stats.get(checkpoint1);
	assert.equal(first.totalAdded, 3);
	assert.equal(first.totalRemoved, 1);
	assert.deepEqual(first.files, [
		{ path: "a.txt", added: 2, removed: 1 },
		{ path: "b.txt", added: 1, removed: 0 },
	]);

	const second = stats.get(checkpoint2);
	assert.equal(second.totalAdded, 0);
	assert.equal(second.totalRemoved, 1);
	assert.deepEqual(second.files, [{ path: "a.txt", added: 0, removed: 1 }]);
});
