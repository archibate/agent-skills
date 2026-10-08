import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { f, ai, sdk, setup, store, PLAN, text, call } from "./support.mjs";

const previousCache = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = join(f.scratch, "cache");
after(() => { if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache; f.cleanup(); });
const toolResults = (h, name) => h.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name).map((entry) => entry.message);

test("Pi's file loader registers the multi-file extension and all three stable tools", async () => {
	const { loadExtensions } = await import(`${f.host}/dist/core/extensions/loader.js`);
	const loaded = await loadExtensions([join(f.scratch, "extension/index.ts")], f.scratch);
	try {
		assert.deepEqual(loaded.errors, []);
		assert.deepEqual([...loaded.extensions[0].tools.keys()], ["enter_plan_mode", "ask_question", "exit_plan_mode"]);
	} finally { loaded.runtime.invalidate(); }
});

test("real Pi loop approves, settles, branches in place, and executes the exact snapshot with stable tools", { timeout: 15000 }, async () => {
	const h = await setup();
	try {
		const sessionId = h.session.sessionManager.getSessionId();
		await h.run();
		assert.equal(h.requests.length, 4, JSON.stringify(h.notices));
		assert.equal(h.session.getLastAssistantText(), "IMPLEMENTATION_STARTED");
		assert.equal(h.session.sessionManager.getSessionId(), sessionId);
		assert.equal(h.plan(), undefined);
		assert.equal(h.navigations.length, 1);
		assert.equal(h.navigations[0].streaming, false);
		assert.deepEqual(h.navigations[0].options, { summarize: false });
		const branch = h.session.sessionManager.getBranch();
		assert.ok(branch.some((entry) => entry.type === "custom_message" && entry.customType === "plan-mode-execute"));
		assert.doesNotMatch(JSON.stringify(h.requests[3].messages), /INVESTIGATION_DEBRIS/);
		assert.match(JSON.stringify(h.requests[3].messages), /Approved SHA-256/);
		assert.ok(JSON.stringify(h.requests[3].messages).includes("Fixture plan"));
		assert.match(JSON.stringify(h.session.sessionManager.getEntries()), /INVESTIGATION_DEBRIS/);
		assert.equal(branch.some((entry) => entry.type === "branch_summary"), false);
		const declarations = h.requests.map((request) => ai.getCurrentTools(request.messages));
		for (const declaration of declarations) assert.deepEqual(declaration, declarations[0]);
		for (const name of ["ask_question", "enter_plan_mode", "exit_plan_mode"]) assert.equal(h.api.getAllTools().find((tool) => tool.name === name).exposure, "model-only");
		const snapshot = toolResults(h, "exit_plan_mode")[0].details.snapshot;
		assert.equal(snapshot.markdown, PLAN);
		assert.equal(readFileSync(snapshot.path, "utf8"), PLAN);
		assert.equal(existsSync(join(h.cwd, "plans")), false);
		assert.ok(h.updates.some((event) => event.partialResult?.details?.snapshot?.markdown === PLAN));
	} finally { h.close(); }
});

for (const activation of ["flag", "command"]) {
	test(`first-session ${activation} entry retains the complete system prompt after checkpoint execution`, async () => {
		const h = await setup({ flag: activation === "flag", next: ({ turn, path }) => turn === 1 ? [call("draft", "draft_fixture")]
			: turn === 2 ? [call("exit", "exit_plan_mode", { plan_path: path })] : [text("IMPLEMENTATION_STARTED")] });
		try {
			if (activation === "command") await h.session.prompt("/plan on");
			await h.run();
			assert.equal(h.requests.length, 3);
			assert.equal(h.plan(), undefined);
			assert.match(JSON.stringify(h.requests[2].messages), /Offline planning fixture/);
			assert.match(JSON.stringify(h.requests[2].messages), /Approved SHA-256/);
			assert.doesNotMatch(JSON.stringify(h.requests[2].messages), /INVESTIGATION_DEBRIS/);
			assert.deepEqual(ai.getCurrentTools(h.requests[2].messages), ai.getCurrentTools(h.requests[0].messages));
		} finally { h.close(); }
	});
}

test("disk-backed session retains the approved snapshot and branch after reopen", async () => {
	const h = await setup({ persistent: true });
	try {
		await h.run();
		const reopened = sdk.SessionManager.open(h.session.sessionFile);
		assert.equal(store.restorePlan(reopened.getBranch()), undefined);
		const entry = reopened.getBranch().find((entry) => entry.type === "custom_message" && entry.customType === "plan-mode-execute");
		assert.equal(entry.details.markdown, PLAN);
		assert.equal(readFileSync(entry.details.path, "utf8"), PLAN);
		assert.match(JSON.stringify(reopened.getEntries()), /INVESTIGATION_DEBRIS/);
	} finally { h.close(); }
});

test("Continue here approves without removing investigation", async () => {
	const h = await setup({ choice: "Continue here" });
	try {
		await h.run();
		assert.equal(h.plan(), undefined);
		assert.equal(h.navigations.length, 0);
		assert.match(JSON.stringify(h.requests.at(-1)), /INVESTIGATION_DEBRIS/);
		assert.match(JSON.stringify(h.requests.at(-1)), /PLAN MODE OFF/);
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "approved");
	} finally { h.close(); }
});

for (const choice of [undefined, "Keep planning", "Request changes"]) {
	test(`approval outcome ${choice ?? "Escape"} preserves planning`, async () => {
		const h = await setup({ choice });
		h.controls.choice = choice;
		try {
			await h.run();
			assert.ok(h.plan());
			assert.equal(h.navigations.length, 0);
			assert.equal(h.requests.length, choice === "Request changes" ? 4 : 3);
			assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, choice === "Request changes" ? "revise" : "cancelled");
			if (choice === "Request changes") assert.match(JSON.stringify(h.requests.at(-1)), /Revise the verification/);
		} finally { h.close(); }
	});
}

test("manual entry shares the controller, is idempotent, and manual exit stays direct", async () => {
	const h = await setup({ next: () => [text("Planning response")] });
	try {
		await h.session.prompt("/plan on");
		const first = h.plan();
		assert.ok(first?.checkpointId);
		await h.session.prompt("/plan on");
		assert.deepEqual(h.plan(), first);
		await h.run("/plan Follow-up question");
		assert.deepEqual(h.plan(), first);
		await h.session.prompt("/plan off");
		assert.equal(h.plan(), undefined);
		assert.equal(h.selections.length, 0);
		await h.run("Implement now");
		assert.match(JSON.stringify(h.requests.at(-1)), /PLAN MODE OFF/);
		assert.equal(h.requests.length, 2);
	} finally { h.close(); }
});

test("startup flag and reload restore the same file/checkpoint without re-enabling a saved exit", async () => {
	const h = await setup({ flag: true, next: () => [text("Response")] });
	try {
		const first = h.plan();
		assert.ok(first);
		await h.run();
		await h.session.reload();
		assert.deepEqual(h.plan(), first);
		await h.session.prompt("/plan off");
		await h.session.reload();
		assert.equal(h.plan(), undefined);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("failed --plan activation blocks tools and remains blocked after reload until an explicit reset", async () => {
	const cache = process.env.XDG_CACHE_HOME;
	const blocked = join(f.scratch, "cache-is-a-file");
	writeFileSync(blocked, "fixture");
	process.env.XDG_CACHE_HOME = blocked;
	let h;
	try {
		h = await setup({ flag: true, next: () => [call("must-not-run", "draft_fixture")] });
		assert.match(h.errors.shift(), /Could not enter planning/);
		assert.throws(h.plan, /Could not enter planning/);
		await h.run();
		assert.equal(h.requests.length, 1);
		assert.equal(toolResults(h, "draft_fixture")[0].isError, true);
		await h.session.reload();
		assert.throws(h.plan, /Could not enter planning/);
		await h.session.prompt("/plan off");
		await h.session.reload();
		assert.equal(h.plan(), undefined);
		assert.deepEqual(h.errors, []);
	} finally { h?.close(); process.env.XDG_CACHE_HOME = cache; }
});

test("corrupt historical state can be reset with /plan off and stays reset after reload", async () => {
	const h = await setup();
	try {
		h.session.sessionManager.appendCustomEntry(store.STATE_ENTRY, { invalid: true });
		await h.session.reload();
		assert.throws(h.plan, /Invalid saved/);
		await h.session.prompt("/plan off");
		await h.session.reload();
		assert.equal(h.plan(), undefined);
		assert.deepEqual(h.errors, []);
	} finally { h.close(); }
});

test("/tree restores planning on the investigation branch and off on implementation branch", async () => {
	const h = await setup();
	try {
		await h.run();
		const executionLeaf = h.session.sessionManager.getLeafId();
		const approvalEntry = h.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "exit_plan_mode");
		await h.session.navigateTree(approvalEntry.id, { summarize: false });
		assert.ok(h.plan());
		await h.session.navigateTree(executionLeaf, { summarize: false });
		assert.equal(h.plan(), undefined);
		assert.equal(h.requests.length, 4, "Navigation must not resume an old approval");
	} finally { h.close(); }
});

test("noninteractive exit renders the plan and stops without granting approval", async () => {
	const h = await setup({ hasUI: false });
	try {
		await h.run();
		assert.ok(h.plan());
		assert.equal(h.requests.length, 3);
		assert.equal(h.navigations.length, 0);
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "unavailable");
	} finally { h.close(); }
});

test("file edits during approval require a fresh review", async () => {
	const h = await setup();
	h.controls.onSelect = () => writeFileSync(h.plan().path, PLAN + "\nChanged after presentation.\n");
	try {
		await h.run();
		assert.ok(h.plan());
		assert.equal(h.navigations.length, 0);
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "changed");
	} finally { h.close(); }
});

test("manual exit during the approval dialog invalidates approval and applies at the boundary", async () => {
	const h = await setup();
	h.controls.onSelect = async ({ session }) => { await session.prompt("/plan off"); };
	try {
		await h.run();
		assert.equal(h.plan(), undefined);
		assert.equal(h.navigations.length, 0);
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "cancelled");
		assert.equal(h.requests.length, 3);
	} finally { h.close(); }
});

test("abort after checkpoint approval prevents the handoff", async () => {
	const h = await setup({ extras: [(pi) => pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "exit_plan_mode") ctx.abort();
	})] });
	try {
		await h.run();
		assert.ok(h.plan());
		assert.equal(h.navigations.length, 0);
		assert.equal(h.requests.length, 3);
	} finally { h.close(); }
});

test("a later boundary continuation invalidates an earlier checkpoint approval", async () => {
	let continued = false;
	const h = await setup({ extras: [(pi) => pi.on("agent_before_settle", (event) => {
		if (!continued && event.outcome === "completed") { continued = true; return { continue: true }; }
	})] });
	try {
		await h.run();
		assert.ok(h.plan());
		assert.equal(h.navigations.length, 0);
		assert.equal(h.requests.length, 4);
	} finally { h.close(); }
});

test("manual entry during a running tool takes effect only after its complete batch", async () => {
	let release, started;
	const ready = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const h = await setup({
		next: ({ turn }) => turn === 1 ? [call("wait", "wait_fixture")] : [text("Planning response")],
		extras: [(pi) => pi.registerTool({ name: "wait_fixture", label: "Wait", description: "Controlled offline fixture", parameters: ai.Type.Object({}),
			execute: async () => { started(); await gate; return { content: [text("Batch completed")], details: undefined }; },
		})],
	});
	try {
		const running = h.run();
		await ready;
		await h.session.prompt("/plan on");
		assert.equal(h.plan(), undefined);
		release();
		await running;
		const branch = h.session.sessionManager.getBranch();
		const checkpoint = branch.findIndex((entry) => entry.id === h.plan().checkpointId);
		const result = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "wait_fixture");
		assert.ok(checkpoint > result);
		assert.match(JSON.stringify(h.requests[1].messages), /PLAN MODE ACTIVE/);
	} finally { release(); h.close(); }
});

test("new user input during approval cancels the stale handoff without losing the input", async () => {
	const h = await setup();
	h.controls.onSelect = async ({ session }) => { await session.followUp("Changed my mind: keep planning."); };
	try {
		await h.run();
		assert.ok(h.plan());
		assert.equal(h.navigations.length, 0);
		assert.match(JSON.stringify(h.requests.at(-1)), /Changed my mind: keep planning/);
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "cancelled");
	} finally { h.close(); }
});

for (const failure of ["cancel", "throw"]) {
	test(`navigation ${failure} leaves planning active and does not start implementation`, async () => {
		const h = await setup();
		h.controls.navigation = async () => { if (failure === "throw") throw new Error("fixture navigation failure"); return { cancelled: true }; };
		try {
			await h.run();
			assert.ok(h.plan());
			assert.equal(h.requests.length, 3);
			assert.match(h.notices.at(-1).message, failure === "throw" ? /navigation failure/ : /cancelled/);
		} finally { h.close(); }
	});
}

test("exit tool outside planning is an inert no-op", async () => {
	const h = await setup({ next: ({ turn }) => turn === 1 ? [call("exit", "exit_plan_mode", { plan_path: "/not/read" })] : [text("Done")] });
	try {
		await h.run();
		assert.equal(toolResults(h, "exit_plan_mode")[0].details.status, "inactive");
		assert.equal(h.selections.length, 0);
	} finally { h.close(); }
});

test("mixed exit batches are rejected before presenting approval", async () => {
	const h = await setup({ next: ({ turn, path }) => turn === 1 ? [call("enter", "enter_plan_mode")]
		: turn === 2 ? [call("draft", "draft_fixture")]
			: turn === 3 ? [call("exit", "exit_plan_mode", { plan_path: path }), call("extra", "ask_question", { questions: [{ question: "Still here?" }] })]
				: [text("Done")] });
	h.controls.input = "yes";
	try {
		await h.run();
		assert.equal(toolResults(h, "exit_plan_mode")[0].isError, true);
		assert.match(JSON.stringify(toolResults(h, "exit_plan_mode")[0].content), /alone/);
		assert.equal(h.selections.length, 0);
		assert.ok(h.plan());
	} finally { h.close(); }
});

test("ask_question works outside planning with a free-text alternative and a batch", async () => {
	const h = await setup({ next: ({ turn }) => turn === 1 ? [call("ask", "ask_question", { questions: [
		{ question: "Which approach?", options: ["A", "B"] }, { question: "Anything else?" },
	] })] : [text("Done")] });
	h.controls.choice = "Type an answer…";
	h.controls.input = "My own answer 中文";
	try {
		await h.run();
		const result = toolResults(h, "ask_question")[0];
		assert.equal(result.details.status, "answered");
		assert.deepEqual(result.details.answers.map((answer) => answer.answer), [h.controls.input, h.controls.input]);
		assert.equal(h.plan(), undefined);
		assert.equal(h.inputs.length, 2);
	} finally { h.close(); }
});

test("ask_question cancellation and missing UI never fabricate answers", async () => {
	for (const hasUI of [true, false]) {
		const h = await setup({ hasUI, next: () => [call("ask", "ask_question", { questions: [{ question: "Choose?", options: ["A"] }] })] });
		h.controls.choice = undefined;
		try {
			await h.run();
			assert.equal(h.requests.length, 1);
			const result = toolResults(h, "ask_question")[0];
			assert.equal(result.details.status, hasUI ? "cancelled" : "unavailable");
			assert.deepEqual(result.details.answers ?? [], []);
		} finally { h.close(); }
	}
});

test("forged internal commands cannot trigger execution", async () => {
	const h = await setup();
	try {
		await h.session.prompt("/plan-handoff forged");
		assert.equal(h.requests.length, 0);
		assert.equal(h.navigations.length, 0);
		assert.match(h.notices.at(-1).message, /No matching/);
	} finally { h.close(); }
});
