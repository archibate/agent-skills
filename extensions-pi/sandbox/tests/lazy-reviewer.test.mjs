import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
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
		for (const load of [
			() => { throw new Error("secret import detail"); },
			async () => { throw new Error("secret import detail"); },
			async () => () => { throw new Error("secret construction detail"); },
			async () => () => ({ name, review: async () => { throw new Error("secret implementation detail"); } }),
		]) {
			const reviewer = lazyReviewer(name, load);
			const result = await reviewer.review(request, {});
			assert.equal(result.kind, "deny");
			assert.doesNotMatch(result.feedback, /secret/);
			assert.equal(result.cancelled, undefined);
			reviewer.dispose();
		}
	}
});
