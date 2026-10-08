import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { f, ai, setup, store, PLAN, call, text } from "./support.mjs";
import registerScratchpad from "../../scratchpad/index.ts";

// No shell, compiler, proxy, or real model runs: only tool_call gates and fake model replies.
// Seed the sandbox's process-local helper cache to suppress its normal startup compilation.
const helperHash = createHash("sha256").update(readFileSync(join(f.scratch, "sandbox/landlock-exec.c"))).digest("hex").slice(0, 16);
const neverExecute = join(f.scratch, "never-execute-helper");
globalThis.__piSandboxHelper = { built: new Map([[helperHash, Promise.resolve(neverExecute)]]) };
const { default: registerSandbox } = await f.loadSandbox("index.ts");
const saved = Object.fromEntries(["XDG_CACHE_HOME", "PI_SCRATCHPAD_DIR", "PI_SANDBOX"].map((key) => [key, process.env[key]]));
process.env.XDG_CACHE_HOME = join(f.scratch, "cache");
process.env.PI_SANDBOX = "1"; // Any accidentally reached non-skipped shell preparation fails before spawning.
after(() => {
	for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	assert.equal(existsSync(neverExecute), false);
	f.cleanup();
});

async function combined({ order = "sandbox-first", sandbox = true, scratchpad = true, flags = {}, ...options } = {}) {
	const h = await setup({
		...options,
		flags: { ...(sandbox ? { "enable-sandbox": true } : {}), ...flags },
		before: order === "sandbox-first" ? [...(scratchpad ? [registerScratchpad] : []), registerSandbox] : [],
		extras: order === "sandbox-first" ? [] : [registerSandbox, ...(scratchpad ? [registerScratchpad] : [])],
	});
	let serial = 0;
	return Object.assign(h, {
		call: (toolName, input = {}) => h.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: `probe-${++serial}`, toolName, input }),
		permissions: () => h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "sandbox-permissions").map((entry) => entry.data),
		provider: () => { let provider; h.api.events.emit("archibate.sandbox:get", (value) => { provider = value; }); return provider; },
	});
}

for (const order of ["sandbox-first", "plan-first"]) {
	test(`${order}: planning denies all escalation before even an automatic reviewer is invoked`, async () => {
		const h = await combined({ order, flag: true, flags: { permissions: '{"dangerouslySkipSandbox":true}', reviewer: "auto", "reviewer-model": "plan-fixture/fixture" } });
		try {
			const initial = structuredClone(h.permissions());
			const tools = structuredClone(h.api.getAllTools());
			for (const sandbox of [
				{ writableLocations: [h.cwd] }, { networkAccess: "full" }, { socketAccess: ["/run/example"] },
				{ sessionBusAccess: true }, { displayAccess: true }, { processAccess: "signalling" },
				{ deviceAccess: "gpu" }, { dangerouslySkipSandbox: true },
			]) {
				for (const tool of ["bash", "job_start"]) assert.match((await h.call(tool, { command: "NEVER EXECUTE", sandbox })).reason, /temporary restriction "plan mode"/);
			}
			for (const tool of ["write", "edit"]) assert.match((await h.call(tool, { path: join(h.cwd, "file.ts"), content: "unused", edits: [] })).reason, /plan mode/);
			assert.match((await h.call("deploy", {})).reason, /plan mode/);
			assert.match((await h.call("job_start", { command: 'pi -p --permissions read-only "investigate"', sandbox: { dangerouslySkipSandbox: true } })).reason, /dangerouslySkipSandbox/);
			assert.equal(h.requests.length, 0, "No automatic review request");
			assert.equal(h.selections.length, 0, "No human approval escape hatch");
			assert.deepEqual(h.permissions(), initial, "Temporary limits never write base permission entries");
			assert.deepEqual(h.api.getAllTools(), tools, "No tool declaration changes");
		} finally { h.close(); }
	});

	test(`${order}: scratchpad edits, fetches, and planning tools work; manual exit releases the ceiling`, async () => {
		const h = await combined({ order, flag: true, flags: { permissions: '{"writableLocations":["."],"networkAccess":"full"}' } });
		try {
			const initial = structuredClone(h.permissions());
			for (const name of ["enter_plan_mode", "ask_question", "exit_plan_mode", "read", "grep", "find", "ls"]) assert.equal(await h.call(name, {}), undefined);
			for (const name of ["write", "edit"]) assert.equal(await h.call(name, { path: h.plan().path, content: "unused", edits: [] }), undefined);
			assert.equal(await h.call("bash", { command: "unused" }), undefined);
			assert.equal(await h.call("job_start", { command: "unused", sandbox: { networkAccess: "fetch-only" } }), undefined);
			await h.session.prompt("/plan off");
			assert.equal(await h.call("write", { path: join(h.cwd, "file.ts") }), undefined);
			assert.equal(await h.call("bash", { sandbox: { networkAccess: "full" } }), undefined);
			assert.deepEqual(h.permissions(), initial);
		} finally { h.close(); }
	});
}

test("a stricter base stays stricter; permission edits during planning survive its exit", async () => {
	const h = await combined({ flag: true, flags: { permissions: "read-only" } });
	try {
		const denied = await h.call("bash", { sandbox: { networkAccess: "fetch-only" } });
		assert.match(denied.reason, /beyond this run's permissions/);
		assert.equal(await h.call("ask_question"), undefined);
		const changed = { writableLocations: [h.cwd], networkAccess: "full" };
		await h.session.prompt(`/permissions ${JSON.stringify(changed)}`);
		assert.match(h.notices.at(-1).message, /limited by plan mode/);
		const savedPermissions = structuredClone(h.permissions());
		await h.session.reload();
		assert.deepEqual(h.permissions(), savedPermissions, "Reload must not reapply the startup permission flag");
		assert.match((await h.call("bash", { sandbox: { networkAccess: "full" } })).reason, /temporary restriction/);
		await h.session.prompt("/plan off");
		assert.equal(await h.call("write", { path: join(h.cwd, "file") }), undefined);
		assert.equal(await h.call("bash", { sandbox: { networkAccess: "full" } }), undefined);
		assert.equal(h.permissions().at(-1).policy.network, "full");
	} finally { h.close(); }
});

test("runtime restrictions are reapplied on reload and branch restoration, not saved as permissions", async () => {
	const h = await combined({ flags: { permissions: '{"dangerouslySkipSandbox":true}' } });
	try {
		await h.session.prompt("/plan on");
		const activeLeaf = h.session.sessionManager.getLeafId();
		const plan = h.plan();
		const originalPermissions = structuredClone(h.permissions());
		await h.session.reload();
		assert.deepEqual(h.plan(), plan);
		assert.match((await h.call("bash", { sandbox: { networkAccess: "full" } })).reason, /plan mode/);
		await h.session.prompt("/plan off");
		const inactiveLeaf = h.session.sessionManager.getLeafId();
		assert.equal(await h.call("bash", { sandbox: { networkAccess: "full" } }), undefined);
		// User/custom-message targets branch before themselves; target the durable mode entries.
		const activeState = h.session.sessionManager.getBranch(activeLeaf).findLast((entry) => entry.type === "custom" && entry.customType === store.STATE_ENTRY);
		await h.session.navigateTree(activeState.id, { summarize: false });
		assert.match((await h.call("bash", { sandbox: { networkAccess: "full" } })).reason, /plan mode/);
		const inactiveState = h.session.sessionManager.getBranch(inactiveLeaf).findLast((entry) => entry.type === "custom" && entry.customType === store.STATE_ENTRY);
		await h.session.navigateTree(inactiveState.id, { summarize: false });
		assert.equal(await h.call("bash", { sandbox: { networkAccess: "full" } }), undefined);
		assert.deepEqual(h.permissions(), originalPermissions);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

for (const choice of ["Execute from checkpoint", "Continue here", "Keep planning"]) {
	test(`real planning tools plus the sandbox: ${choice}`, async () => {
		const h = await combined({ builtin: true, choice, flags: { permissions: '{"writableLocations":["."],"networkAccess":"full"}' }, next: ({ turn, path }) =>
			turn === 1 ? [call("enter", "enter_plan_mode")]
				: turn === 2 ? [call("draft", "write", { path, content: PLAN })]
					: turn === 3 ? [call("exit", "exit_plan_mode", { plan_path: path })]
						: [text("Implementation response")] });
		try {
			await h.run();
			const blocked = await h.call("write", { path: join(h.cwd, "should-not-be-written") });
			if (choice === "Keep planning") assert.match(blocked.reason, /plan mode/);
			else assert.equal(blocked, undefined);
			assert.equal(h.navigations.length, choice === "Execute from checkpoint" ? 1 : 0);
			assert.equal(h.requests.length, choice === "Keep planning" ? 3 : 4);
			assert.equal(existsSync(join(h.cwd, "should-not-be-written")), false);
			const loadouts = h.requests.map((request) => ai.getCurrentTools(request.messages));
			for (const loadout of loadouts) assert.deepEqual(loadout, loadouts[0]);
		} finally { h.close(); }
	});
}

test("checkpoint execution carries current base permissions rather than resurrecting the earlier grants", async () => {
	const h = await combined({ builtin: true, flags: { permissions: '{"writableLocations":["."],"networkAccess":"full"}' }, next: ({ turn, path }) =>
		turn === 1 ? [call("enter", "enter_plan_mode")]
			: turn === 2 ? [call("draft", "write", { path, content: PLAN })]
				: turn === 3 ? [call("exit", "exit_plan_mode", { plan_path: path })] : [text("Done")] });
	h.controls.onSelect = async () => { await h.session.prompt("/permissions read-only"); };
	try {
		await h.run();
		assert.equal(h.plan(), undefined);
		assert.equal(h.navigations.length, 1);
		assert.equal(h.permissions().at(-1).policy.network, "disable");
		assert.deepEqual(h.permissions().at(-1).policy.writable, []);
		const denied = await h.call("bash", { sandbox: { networkAccess: "full" } });
		assert.match(denied.reason, /beyond this run's permissions/);
		assert.doesNotMatch(denied.reason, /temporary restriction/);
	} finally { h.close(); }
});

test("a stale permission handoff cannot overwrite newer explicit permission edits", async () => {
	const h = await combined();
	try {
		const commit = h.provider().carryPermissions();
		await h.session.prompt("/permissions read-only");
		assert.throws(commit, /Permissions changed during handoff/);
		assert.equal(h.permissions().at(-1).policy.network, "disable");
	} finally { h.close(); }
});

test("the plan file remains writable without the scratchpad extension, including an inherited stale variable", async () => {
	const previous = process.env.PI_SCRATCHPAD_DIR;
	try {
		for (const inherited of [undefined, f.scratch]) {
			if (inherited) process.env.PI_SCRATCHPAD_DIR = inherited; else delete process.env.PI_SCRATCHPAD_DIR;
			const h = await combined({ scratchpad: false, flag: true, flags: { permissions: "read-only" } });
			try {
				for (const tool of ["write", "edit"]) assert.equal(await h.call(tool, { path: h.plan().path }), undefined);
				assert.equal(await h.call("bash", { sandbox: { writableLocations: [h.plan().path] } }), undefined);
				assert.match((await h.call("write", { path: join(h.cwd, "file") })).reason, /temporary restriction/);
				assert.match((await h.call("bash", { sandbox: { networkAccess: "fetch-only" } })).reason, /beyond this run's permissions/);
			} finally { h.close(); }
		}
	} finally { if (previous === undefined) delete process.env.PI_SCRATCHPAD_DIR; else process.env.PI_SCRATCHPAD_DIR = previous; }
});

test("automatic review decisions and usage keep being recorded after ceiling entry and exit", async () => {
	const h = await combined({ flags: { permissions: "read-only", reviewer: "auto", "reviewer-model": "plan-fixture/fixture" } });
	const registry = h.session.extensionRunner.getModelRegistry();
	registry.find = () => h.session.model;
	registry.hasConfiguredAuth = () => true;
	registry.streamSimple = () => {
		const stream = ai.createAssistantMessageEventStream();
		const model = h.session.model;
		const message = { role: "assistant", content: [text('{"decision":"approve","reason":"Offline fixture"}')], api: model.api, provider: model.provider, model: model.id,
			stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
		return stream;
	};
	try {
		const request = { command: "NEVER EXECUTE", sandbox: { networkAccess: "full" } };
		assert.equal(await h.call("bash", request), undefined);
		await h.session.prompt("/plan on");
		assert.match((await h.call("bash", request)).reason, /temporary restriction/);
		await h.session.prompt("/plan off");
		assert.equal(await h.call("bash", request), undefined);
		const records = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "sandbox-auto-review");
		assert.equal(records.length, 2);
		assert.ok(records.every((record) => record.data.usage?.totalTokens === 2));
	} finally { h.close(); }
});

test("disabled sandbox remains inert and planning does not enable it", async () => {
	const h = await combined({ sandbox: false, flag: true });
	try {
		assert.equal(h.provider(), undefined);
		assert.equal(await h.call("bash", { sandbox: { dangerouslySkipSandbox: true } }), undefined);
		assert.equal(await h.call("write", { path: join(h.cwd, "file") }), undefined);
		assert.equal(h.permissions().length, 0);
	} finally { h.close(); }
});

test("launch-time checks reject unsafe preparation and revoke a not-yet-launched prepared shell", async () => {
	const h = await combined();
	let prepared;
	try {
		const provider = h.provider();
		prepared = await provider.prepare({ dangerouslySkipSandbox: true }, h.cwd); // Builds no helper, proxy, or process.
		await h.session.prompt("/plan on");
		const unwritten = join(h.cwd, "not-created");
		await assert.rejects(provider.prepare({ writableLocations: [unwritten] }, h.cwd), /temporary restriction/);
		await assert.rejects(provider.prepare({ dangerouslySkipSandbox: true }, h.cwd), /temporary restriction/);
		assert.equal(existsSync(unwritten), false);
		assert.throws(() => prepared.shell({ shell: "/bin/false", args: [] }), /permissions changed before launch/);
		assert.throws(() => prepared.env({}), /permissions changed before launch/);
	} finally { await prepared?.dispose(); h.close(); }
});

test("entering planning cancels in-flight and queued reviews, including late automatic approvals", async () => {
	const h = await combined({ flags: { reviewer: "auto", "reviewer-model": "plan-fixture/fixture" } });
	let finish, start;
	const ready = new Promise((resolve) => { start = resolve; });
	let reviews = 0;
	const registry = h.session.extensionRunner.getModelRegistry();
	registry.find = () => h.session.model;
	registry.hasConfiguredAuth = () => true;
	registry.streamSimple = () => {
		reviews++;
		const stream = ai.createAssistantMessageEventStream();
		finish = () => {
			const model = h.session.model;
			const message = { role: "assistant", content: [text('{"decision":"approve","reason":"Late fixture approval"}')], api: model.api, provider: model.provider, model: model.id,
				stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "done", reason: "stop", message }); stream.end();
		};
		start(); return stream;
	};
	try {
		const request = { command: "NEVER EXECUTE", sandbox: { networkAccess: "full" } };
		const active = h.call("bash", request);
		await ready;
		const queued = h.call("bash", request);
		await h.session.prompt("/plan on");
		assert.equal((await active).block, true);
		assert.equal((await queued).block, true);
		finish();
		assert.equal(reviews, 1);
		assert.match((await h.call("bash", request)).reason, /temporary restriction/);
		assert.equal(reviews, 1);
	} finally { finish?.(); h.close(); }
});

test("a failed optional sandbox integration blocks tool execution until manually reset", async () => {
	const h = await setup({ extras: [(pi) => pi.events.on("archibate.sandbox:get", (reply) => reply({ restrict() {} }))] });
	try {
		await h.session.prompt("/plan on");
		const blocked = await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "probe", toolName: "write", input: { path: join(h.cwd, "file") } });
		assert.match(blocked.reason, /Reload the sandbox extension/);
		await h.session.prompt("/plan off");
		assert.equal(await h.session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "probe2", toolName: "write", input: { path: join(h.cwd, "file") } }), undefined);
	} finally { h.close(); }
});
