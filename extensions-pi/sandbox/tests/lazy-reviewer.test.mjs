import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { lazyReviewer } from "../lazy-reviewer.ts";

const request = { toolName: "bash", input: {}, cwd: "/work", subject: "bash", excess: [] };
const approve = { kind: "approve", source: "auto", reason: "Fixture approval" };
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
};

function fixture(load = deferred()) {
	const calls = { load: 0, create: 0, review: 0, reset: 0, dispose: 0 };
	const implementation = {
		name: "auto",
		async review(_request, ctx) { calls.review++; assert.ok(ctx.signal instanceof AbortSignal); return approve; },
		reset() { calls.reset++; }, dispose() { calls.dispose++; },
	};
	const create = () => { calls.create++; return implementation; };
	const reviewer = lazyReviewer("auto", () => { calls.load++; return load.promise; });
	return { load, calls, implementation, create, reviewer };
}

const cancelled = (verdict) => {
	assert.equal(verdict.kind, "deny");
	assert.equal(verdict.cancelled, true);
};

test("loading and construction are deferred, shared, and retain one implementation", async () => {
	const f = fixture();
	assert.equal(f.calls.load, 0);
	const first = f.reviewer.review(request, {});
	const second = f.reviewer.review(request, {});
	await setImmediate();
	assert.equal(f.calls.load, 1);
	assert.equal(f.calls.create, 0);
	f.load.resolve(f.create);
	assert.deepEqual(await first, approve);
	assert.deepEqual(await second, approve);
	f.reviewer.reset();
	assert.deepEqual(await f.reviewer.review(request, {}), approve);
	f.reviewer.dispose();
	f.reviewer.dispose();
	f.reviewer.reset();
	cancelled(await f.reviewer.review(request, {}));
	assert.deepEqual(f.calls, { load: 1, create: 1, review: 3, reset: 1, dispose: 1 });
});

test("already aborted or disposed reviewers never load an implementation", async () => {
	const f = fixture();
	cancelled(await f.reviewer.review(request, { signal: AbortSignal.abort() }));
	f.reviewer.dispose();
	cancelled(await f.reviewer.review(request, {}));
	assert.equal(f.calls.load, 0);
});

for (const action of ["abort", "reset", "dispose"]) {
	test(`${action} during import resolves promptly and never constructs or reviews late`, { timeout: 1000 }, async () => {
		const f = fixture();
		const controller = new AbortController();
		const pending = f.reviewer.review(request, { signal: controller.signal });
		await setImmediate();
		if (action === "abort") controller.abort();
		else f.reviewer[action]();
		cancelled(await pending);
		f.load.resolve(f.create);
		await setImmediate();
		assert.equal(f.calls.create, 0);
		assert.equal(f.calls.review, 0);
	});
}

test("reset during import allows only the new review to use the completed module", { timeout: 1000 }, async () => {
	const f = fixture();
	const stale = f.reviewer.review(request, {});
	await setImmediate();
	f.reviewer.reset();
	cancelled(await stale);
	const fresh = f.reviewer.review(request, {});
	f.load.resolve(f.create);
	assert.deepEqual(await fresh, approve);
	assert.equal(f.calls.load, 1);
	assert.equal(f.calls.create, 1);
	assert.equal(f.calls.review, 1);
	f.reviewer.dispose();
});

test("a late import rejection after cancellation is consumed", { timeout: 1000 }, async () => {
	const f = fixture();
	const pending = f.reviewer.review(request, {});
	await setImmediate();
	f.reviewer.dispose();
	cancelled(await pending);
	f.load.reject(new Error("Late fixture import failure"));
	await setImmediate();
	assert.equal(f.calls.create, 0);
});

for (const action of ["abort", "reset", "dispose"]) {
	test(`${action} during a running review rejects an uncooperative late approval`, { timeout: 1000 }, async () => {
		const f = fixture();
		const reply = deferred();
		let context;
		f.implementation.review = (_request, ctx) => { f.calls.review++; context = ctx; return reply.promise; };
		f.load.resolve(f.create);
		const controller = new AbortController();
		const pending = f.reviewer.review(request, { signal: controller.signal });
		await setImmediate();
		assert.equal(f.calls.review, 1);
		if (action === "abort") controller.abort();
		else f.reviewer[action]();
		cancelled(await pending);
		assert.equal(context.signal.aborted, true);
		reply.resolve(approve);
		await setImmediate();
		f.reviewer.dispose();
	});
}

test("import, construction, and implementation failures deny without leaking error details", async () => {
	for (const name of ["auto", "manual"]) {
		for (const [phase, load] of [
			["load", () => { throw new Error("secret import detail"); }],
			["load", async () => { throw new Error("secret import detail"); }],
			["construct", async () => () => { throw new Error("secret construction detail"); }],
			["review", async () => () => ({ name, review: async () => { throw new Error("secret implementation detail"); } })],
		]) {
			const failures = [];
			const reviewer = lazyReviewer(name, load, { onFailure: (failure) => failures.push(failure) });
			const result = await reviewer.review(request, {});
			assert.equal(result.kind, "deny");
			assert.doesNotMatch(result.feedback, /secret/);
			assert.equal(result.cancelled, undefined);
			assert.equal(failures.length, 1);
			assert.equal(failures[0].phase, phase);
			assert.equal(failures[0].feedback, result.feedback);
			assert.ok(failures[0].elapsedMs >= 0);
			reviewer.dispose();
		}
	}
});

test("a hung import has a cached deadline and cannot construct after late completion", async () => {
	const load = deferred();
	const failures = [];
	let loads = 0;
	let creates = 0;
	const reviewer = lazyReviewer("auto", () => { loads++; return load.promise; }, {
		timeoutMs: 10, onFailure: (failure) => failures.push(failure),
	});
	const first = reviewer.review(request, {});
	// Keep this pure fixture alive while the implementation's deadline timer is unref'd.
	await sleep(20);
	assert.match((await first).feedback, /loading timed out/);
	assert.match((await reviewer.review(request, {})).feedback, /loading timed out/);
	assert.equal(loads, 1);
	assert.equal(failures.length, 2);
	assert.ok(failures.every((failure) => failure.phase === "load"));
	load.resolve(() => { creates++; return { name: "auto", review: async () => approve }; });
	await setImmediate();
	assert.match((await reviewer.review(request, {})).feedback, /loading timed out/);
	assert.equal(creates, 0);
	reviewer.dispose();
});

test("a failed failure-audit callback denies without throwing or permitting escalation", async () => {
	const reviewer = lazyReviewer("auto", async () => { throw new Error("secret import"); }, {
		onFailure: () => { throw new Error("secret storage failure"); },
	});
	const result = await reviewer.review(request, {});
	cancelled(result);
	assert.match(result.feedback, /audit could not be recorded/);
	assert.doesNotMatch(result.feedback, /secret/);
	reviewer.dispose();
});

test("load timers and review abort listeners are removed after settlement", async (t) => {
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeClearTimeout = globalThis.clearTimeout;
	const timers = new Set();
	globalThis.setTimeout = (...args) => { const timer = nativeSetTimeout(...args); timers.add(timer); return timer; };
	globalThis.clearTimeout = (timer) => { timers.delete(timer); nativeClearTimeout(timer); };
	t.after(() => { globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout; });
	for (const outcome of ["approve", "reject", "abort"]) {
		const reply = deferred();
		let context;
		const reviewer = lazyReviewer("auto", async () => () => ({
			name: "auto", review: (_request, ctx) => { context = ctx; return reply.promise; },
		}));
		const controller = new AbortController();
		const pending = reviewer.review(request, { signal: controller.signal });
		await setImmediate();
		assert.equal(timers.size, 0);
		assert.equal(getEventListeners(context.signal, "abort").length, 1);
		if (outcome === "abort") controller.abort();
		if (outcome === "reject") reply.reject(new Error("fixture review failed"));
		else reply.resolve(approve);
		await pending;
		assert.equal(getEventListeners(context.signal, "abort").length, 0);
		assert.equal(timers.size, 0);
		reviewer.dispose();
	}
});
