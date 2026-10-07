import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { CostPublisher, entryCost, observeAppends, REGISTRATION, registrationIn } from "../accounting.ts";
import { CostLedger, ledgerDirectory, publish, recordName } from "../ledger.ts";
import { SUMMARY } from "../presentation.ts";

const scratch = process.env.PI_SCRATCHPAD_DIR;
assert.ok(scratch, "Run filesystem tests in an agent-owned PI_SCRATCHPAD_DIR");
const usage = (total) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
	cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const assistant = (cost, stopReason = "stop") => ({ role: "assistant", content: [], provider: "test", model: "test", api: "test",
	usage: usage(cost), stopReason, timestamp: Date.now() });
const user = () => ({ role: "user", content: "fixture", timestamp: Date.now() });
function fixture(t) {
	const dir = mkdtempSync(join(scratch, "subagent-cost-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function manager(dir, id) {
	const sm = SessionManager.create(dir, join(dir, "sessions"), { id });
	sm.appendMessage(user());
	return sm;
}
function run(sm, parent) {
	const handlers = new Map();
	const notices = [], statuses = [];
	extension({ on: (name, handler) => handlers.set(name, handler), appendEntry: (type, data) => sm.appendCustomEntry(type, data) });
	const ctx = { sessionManager: sm, hasUI: true, mode: "tui", ui: {
		notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args),
	} };
	const previous = process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
	if (parent) process.env.PI_SUBAGENT_PARENT_SESSION_FILE = parent;
	else delete process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
	try { handlers.get("session_start")({ reason: "startup" }, ctx); }
	finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
		else process.env.PI_SUBAGENT_PARENT_SESSION_FILE = previous;
	}
	return { notices, statuses, summary: () => sm[SUMMARY](),
		reconcile: () => handlers.get("before_agent_start")({}, ctx),
		stop: () => handlers.get("session_shutdown")({}, ctx) };
}
function record(parent, child, costUSD) {
	return { version: 1, parentSessionFile: parent, childSessionFile: child, childSessionId: "child", costUSD };
}
async function waitFor(predicate) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "watch delivery timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("all core cost entry types, no double counting nested usage or context edits", () => {
	for (const type of ["usage", "compaction", "branch_summary"]) assert.equal(entryCost({ type, usage: usage(0.5) }), 0.5);
	assert.equal(entryCost({ type: "message", message: assistant(0.5, "aborted") }), 0.5);
	assert.equal(entryCost({ type: "message", message: { role: "toolResult", usage: usage(0.75), details: { calls: [{ cost: 0.75 }] } } }), 0.75);
	for (const type of ["custom", "context_edit", "model_change"]) assert.equal(entryCost({ type, usage: usage(50) }), 0);
	assert.equal(entryCost({ type: "message", message: user() }), 0);
	for (const cost of [-1, NaN, Infinity, "1"]) assert.throws(() => entryCost({ type: "usage", usage: usage(cost) }));
});

test("fork baseline, failed/cancelled calls, summaries, idle usage, resume and reload", async (t) => {
	const dir = fixture(t);
	const parent = manager(dir, "parent");
	parent.appendMessage(assistant(100));
	const p = run(parent);
	t.after(p.stop);
	const child = SessionManager.forkFrom(parent.getSessionFile(), dir, join(dir, "sessions"), { id: "parent.child" });
	const originalAppend = child._appendEntry;
	const c = run(child, parent.getSessionFile());
	assert.deepEqual(c.notices, []);
	assert.notEqual(child._appendEntry, originalAppend);
	child.appendMessage(assistant(0.25, "error"));
	child.appendMessage(assistant(0.25, "aborted"));
	child.appendMessage({ role: "toolResult", content: [], toolCallId: "t", toolName: "test", isError: true, timestamp: Date.now(), usage: usage(0.5) });
	child.appendUsage("cache_warm", "test", "test", usage(0.5));
	child.appendUsage("arbitrary-kind", "test", "test", usage(0.5));
	child.appendCompaction("summary", undefined, 100, undefined, false, usage(0.5));
	child.branchWithSummary(null, "branch", undefined, false, usage(0.5));
	await waitFor(() => p.summary().costUSD === 3);
	assert.deepEqual(p.summary(), { costUSD: 3, count: 1 });
	assert.equal(p.notices.length, 0);
	c.stop();
	c.stop();
	assert.equal(child._appendEntry, originalAppend);
	assert.equal(child[SUMMARY], undefined);

	const resumed = SessionManager.open(child.getSessionFile());
	const r = run(resumed); // No environment needed: registration is durable non-context state.
	t.after(r.stop);
	resumed.appendUsage("cache_warm", "test", "test", usage(1));
	await waitFor(() => p.summary().costUSD === 4);
	r.stop();
	const reload = run(resumed);
	t.after(reload.stop);
	resumed.appendMessage(assistant(1));
	await waitFor(() => p.summary().costUSD === 5);
	assert.equal(resumed.getEntries().filter((e) => e.type === "custom" && e.customType === REGISTRATION).length, 1);

	// A fork of a previously registered child must not reuse its marker or previous costs.
	const fork = SessionManager.forkFrom(resumed.getSessionFile(), dir, join(dir, "sessions"), { id: "parent.fork" });
	const f = run(fork, parent.getSessionFile());
	t.after(f.stop);
	fork.appendMessage(assistant(2));
	await waitFor(() => p.summary().costUSD === 7);
	assert.equal(p.summary().count, 2);
	assert.equal(registrationIn(fork.getEntries(), fork.getSessionFile()).registration.parentSessionFile, parent.getSessionFile());
	p.stop();
	const reopened = run(SessionManager.open(parent.getSessionFile()));
	t.after(reopened.stop);
	assert.deepEqual(reopened.summary(), { costUSD: 7, count: 2 });
});

test("new child, no historical backfill, parent absent, no registration for parent itself", (t) => {
	const dir = fixture(t);
	const parent = manager(dir, "parent");
	const child = manager(dir, "fresh");
	child.appendMessage(assistant(10));
	const c = run(child, parent.getSessionFile());
	t.after(c.stop);
	child.appendMessage(assistant(1));
	const p = run(parent);
	t.after(p.stop);
	assert.deepEqual(p.summary(), { costUSD: 1, count: 1 });
	const selfManager = manager(dir, "self");
	const self = run(selfManager, selfManager.getSessionFile());
	t.after(self.stop);
	assert.equal(registrationIn(selfManager.getEntries(), selfManager.getSessionFile()), undefined);
	assert.equal(readdirSync(ledgerDirectory(parent.getSessionFile())).length, 1);
	assert.equal(statSync(ledgerDirectory(parent.getSessionFile())).mode & 0o777, 0o700);
	const path = join(ledgerDirectory(parent.getSessionFile()), recordName(child.getSessionFile()));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(path)).costUSD, 1);
});

test("atomic replacement watcher, duplicate updates, bounded pending work, idle and disposal", async (t) => {
	const dir = fixture(t);
	const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
	const errors = [];
	let changes = 0;
	const ledger = new CostLedger(parent, () => changes++, (e) => errors.push(e));
	t.after(() => ledger.close());
	for (let cost = 1; cost <= 20; cost++) publish(record(parent, child, cost));
	await waitFor(() => ledger.summary().costUSD === 20);
	publish(record(parent, child, 20));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(ledger.summary().costUSD, 20);
	assert.ok(changes <= 2, "notifications are coalesced");
	assert.deepEqual(errors, []);
	assert.equal(ledger.timer, undefined, "no idle timer");
	assert.equal(ledger.pending.size, 0);
	for (let i = 0; i < 2000; i++) ledger.schedule(i.toString(16).padStart(64, "0") + ".json");
	assert.ok(ledger.pending.size <= 1024);
	ledger.close(); // Cancels the queued reconciliation too.
	ledger.close();
	publish(record(parent, child, 21));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(ledger.summary().costUSD, 20);
	assert.equal(ledger.timer, undefined);
	assert.equal(ledger.watcher, undefined);
});

test("missed events and watcher errors reconcile on demand, corrupt records retain valid total", async (t) => {
	const dir = fixture(t);
	const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
	const errors = [];
	const ledger = new CostLedger(parent, () => {}, (e) => errors.push(e));
	t.after(() => ledger.close());
	publish(record(parent, child, 1));
	await waitFor(() => ledger.summary().costUSD === 1);
	ledger.watcher.emit("error", new Error("injected watch failure"));
	assert.equal(ledger.watcher, undefined);
	publish(record(parent, child, 2));
	ledger.reconcile();
	assert.equal(ledger.summary().costUSD, 2);
	assert.ok(ledger.watcher);
	const path = join(ledger.directory, recordName(child));
	writeFileSync(path, "{partial");
	ledger.reconcile();
	assert.equal(ledger.summary().costUSD, 2);
	writeFileSync(path, "x".repeat(32769));
	ledger.reconcile();
	assert.equal(ledger.summary().costUSD, 2);
	publish(record(parent, child, 3));
	ledger.reconcile();
	assert.equal(ledger.summary().costUSD, 3);
	assert.ok(errors.length >= 3);
});

test("unsafe paths, symlink snapshots and wrong-parent records are rejected", (t) => {
	const dir = fixture(t);
	const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
	const errors = [];
	const ledger = new CostLedger(parent, () => {}, (e) => errors.push(e));
	t.after(() => ledger.close());
	const target = join(dir, "untouched");
	writeFileSync(target, "not accounting");
	symlinkSync(target, join(ledger.directory, recordName(child)));
	ledger.reconcile();
	assert.equal(errors.length, 1);
	assert.equal(ledger.summary().count, 0);
	publish(record(parent, child, 1)); // Atomic replacement replaces the link, never its target.
	assert.equal(readFileSync(target, "utf8"), "not accounting");
	writeFileSync(join(ledger.directory, recordName(child)), JSON.stringify(record("/wrong/parent", child, 99)));
	ledger.reconcile();
	assert.equal(ledger.summary().count, 0);
	const unsafe = join(dir, "unsafe.jsonl");
	symlinkSync(dir, ledgerDirectory(unsafe));
	assert.throws(() => new CostLedger(unsafe, () => {}, () => {}), /Unsafe accounting directory/);
});

test("publisher failures cannot fail core appends, retries and adapter teardown are idempotent", (t) => {
	const dir = fixture(t);
	const sm = manager(dir, "child");
	const original = sm._appendEntry;
	const errors = [];
	const stop = observeAppends(sm, () => { throw new Error("disk full"); }, (e) => errors.push(e));
	assert.doesNotThrow(() => sm.appendMessage(assistant(1)));
	assert.equal(errors.length, 1);
	assert.equal(sm.getEntries().at(-1).message.usage.cost.total, 1);
	stop(); stop();
	assert.equal(sm._appendEntry, original);
});

test("initialization failure warns once; in-memory sessions create no accounting resources", (t) => {
	const dir = fixture(t);
	const parent = manager(dir, "parent");
	symlinkSync(dir, ledgerDirectory(parent.getSessionFile()));
	const p = run(parent);
	t.after(p.stop);
	p.reconcile(); p.reconcile();
	assert.equal(p.notices.length, 1);
	assert.equal(parent[SUMMARY], undefined);
	const memory = SessionManager.inMemory();
	const m = run(memory);
	t.after(m.stop);
	assert.equal(memory[SUMMARY], undefined);
	assert.equal(m.notices.length, 0);
});

test("resuming through a file symlink preserves the existing registration", async (t) => {
	const dir = fixture(t);
	const parent = manager(dir, "parent"), child = manager(dir, "child");
	const p = run(parent), c = run(child, parent.getSessionFile());
	t.after(p.stop); t.after(c.stop);
	child.appendMessage(assistant(1));
	c.stop();
	const alias = join(dir, "alias.jsonl");
	symlinkSync(child.getSessionFile(), alias);
	const resumed = SessionManager.open(alias);
	const r = run(resumed);
	t.after(r.stop);
	resumed.appendMessage(assistant(2));
	await waitFor(() => p.summary().costUSD === 3);
	assert.deepEqual(p.summary(), { costUSD: 3, count: 1 });
	assert.deepEqual(r.notices, []);
});

test("replaced ledger directories reattach live watches instead of watching an old inode", async (t) => {
	const dir = fixture(t);
	const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
	const ledger = new CostLedger(parent, () => {}, () => {});
	t.after(() => ledger.close());
	publish(record(parent, child, 1));
	await waitFor(() => ledger.summary().costUSD === 1);
	const original = ledger.watcher;
	renameSync(ledger.directory, ledger.directory + ".old");
	publish(record(parent, child, 2));
	ledger.reconcile();
	assert.equal(ledger.summary().costUSD, 2);
	assert.notEqual(ledger.watcher, original);
	publish(record(parent, child, 3));
	await waitFor(() => ledger.summary().costUSD === 3);
});

test("publication failure retries the cumulative total; reporting failures never escape accounting", (t) => {
	const dir = fixture(t);
	const parent = join(dir, "parent.jsonl"), child = join(dir, "child.jsonl");
	let writes = 0;
	const publisher = new CostPublisher(record(parent, child, 0), (r) => {
		if (writes++ === 0) throw new Error("disk full");
		assert.equal(r.costUSD, 1);
	});
	publisher.add({ type: "usage", usage: usage(1) });
	assert.throws(() => publisher.flush(), /disk full/);
	publisher.flush(); publisher.flush();
	assert.equal(writes, 2);
	const sm = manager(dir, "child");
	const stop = observeAppends(sm, () => { throw new Error("accounting failed"); }, () => { throw new Error("UI failed"); });
	t.after(stop);
	assert.doesNotThrow(() => sm.appendMessage(assistant(1)));
	assert.equal(sm.getEntries().at(-1).message.usage.cost.total, 1);
	const brokenCore = { _appendEntry() { throw new Error("core failure"); } };
	observeAppends(brokenCore, () => assert.fail("must not report unpersisted usage"), () => {});
	assert.throws(() => brokenCore._appendEntry({}), /core failure/);
	publish(record(parent, child, 1));
	const ledger = new CostLedger(parent, () => { throw new Error("render failed"); }, () => { throw new Error("diagnostics failed"); });
	t.after(() => ledger.close());
	assert.equal(ledger.summary().costUSD, 1);
	assert.doesNotThrow(() => ledger.watcher.emit("error", new Error("watch failure")));
	assert.doesNotThrow(() => ledger.reconcile());
});
