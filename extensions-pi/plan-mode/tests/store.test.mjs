import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
const { createPlan, readPlan, restorePlan, MAX_PLAN_BYTES, STATE_ENTRY, CHECKPOINT_ENTRY } = await f.load("store.ts");
const oldCache = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = join(f.scratch, "cache");
after(() => { if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache; f.cleanup(); });
let sequence = 0;
const fresh = () => createPlan(`test-${++sequence}`);

test("creates private retained Markdown files in the session scratchpad without overwriting another plan", () => {
	const first = createPlan("same-session"), second = createPlan("same-session");
	assert.notEqual(first.path, second.path);
	assert.ok(first.path.startsWith(join(process.env.XDG_CACHE_HOME, "pi/scratchpad/same-session") + "/"));
	assert.equal(readFileSync(first.path, "utf8"), "");
	assert.equal(statSync(first.path).mode & 0o777, 0o600);
	assert.equal(statSync(join(process.env.XDG_CACHE_HOME, "pi/scratchpad/same-session")).mode & 0o777, 0o700);
});

test("rejects traversal session IDs", () => {
	for (const id of ["", "../escape", "/absolute", "a/b", "..", "trailing-"]) assert.throws(() => createPlan(id), /session ID/);
});

test("regular Markdown is decoded exactly and hashes change with its revision", () => {
	const plan = fresh();
	const markdown = "# 计划\n\nUse `src/file.ts`. 🙂\n";
	writeFileSync(plan.path, markdown);
	const first = readPlan(plan, plan.path);
	assert.equal(first.markdown, markdown);
	assert.match(first.sha256, /^[a-f0-9]{64}$/);
	writeFileSync(plan.path, markdown + "Revision\n");
	assert.notEqual(readPlan(plan, plan.path).sha256, first.sha256);
	assert.equal(first.markdown, markdown, "An approved snapshot is independent of later edits");
});

test("bounds file content and rejects empty, invalid UTF-8, and terminal controls", () => {
	const plan = fresh();
	for (const content of ["", " \n\t", Buffer.from([0xff]), "# Plan\n\x1b[2J", "x".repeat(MAX_PLAN_BYTES + 1)]) {
		writeFileSync(plan.path, content);
		assert.throws(() => readPlan(plan, plan.path));
	}
	writeFileSync(plan.path, "x".repeat(MAX_PLAN_BYTES));
	assert.equal(readPlan(plan, plan.path).markdown.length, MAX_PLAN_BYTES);
});

test("rejects alternate files, missing files, directories, and final symlinks", () => {
	const plan = fresh();
	const other = join(f.scratch, "other.md");
	writeFileSync(other, "not the plan");
	assert.throws(() => readPlan(plan, other), /active plan file/);
	rmSync(plan.path);
	assert.throws(() => readPlan(plan, plan.path));
	symlinkSync(other, plan.path);
	assert.throws(() => readPlan(plan, plan.path), /symlink/);
	rmSync(plan.path);
	mkdirSync(plan.path);
	assert.throws(() => readPlan(plan, plan.path), /regular/);
});

test("rejects a replaced parent directory and insecure existing storage", () => {
	const plan = fresh();
	const sessionDirectory = join(plan.path, "..");
	rmSync(plan.path);
	rmSync(sessionDirectory, { recursive: true });
	const other = mkdtempSync(join(f.scratch, "other-parent-"));
	symlinkSync(other, sessionDirectory);
	assert.throws(() => createPlan(`test-${sequence}`), /Unsafe/);
	const insecure = createPlan("insecure");
	chmodSync(join(insecure.path, ".."), 0o777);
	assert.throws(() => createPlan("insecure"), /Unsafe/);
	chmodSync(join(insecure.path, ".."), 0o700);
});

test("restores only the supplied branch and recovers a completed entry checkpoint", () => {
	const plan = fresh();
	const state = { type: "custom", customType: STATE_ENTRY, data: { version: 1, plan } };
	const checkpoint = { type: "custom", customType: CHECKPOINT_ENTRY, id: "checkpoint", data: { planId: plan.id } };
	const before = structuredClone(state);
	assert.deepEqual(restorePlan([state]), plan);
	assert.deepEqual(restorePlan([state, checkpoint]), { ...plan, checkpointId: "checkpoint" });
	assert.deepEqual(state, before);
	assert.equal(restorePlan([state, checkpoint, { type: "custom", customType: STATE_ENTRY, data: { version: 1, plan: null } }]), undefined);
	assert.equal(restorePlan([]), undefined);
	assert.ok(existsSync(plan.path));
});

test("an explicit newer reset supersedes corrupted history and saved activation failures", () => {
	const reset = { type: "custom", customType: STATE_ENTRY, data: { version: 1, plan: null } };
	for (const data of [{ broken: true }, { version: 1, plan: null, failure: "Storage unavailable" }]) {
		const bad = { type: "custom", customType: STATE_ENTRY, data };
		assert.throws(() => restorePlan([bad]));
		assert.equal(restorePlan([bad, reset]), undefined);
	}
});

test("invalid durable state fails closed instead of silently enabling implementation", () => {
	for (const data of [undefined, {}, { version: 2, plan: null }, { version: 1, plan: {} }, { version: 1, plan: { id: "x", path: "relative", checkpointId: null } }]) {
		assert.throws(() => restorePlan([{ type: "custom", customType: STATE_ENTRY, data }]), /Invalid saved planning state/);
	}
});
