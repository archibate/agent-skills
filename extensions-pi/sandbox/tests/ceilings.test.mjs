import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionCeilings } from "../ceilings.ts";
import { assessCall, intersectAllowance, parsePermissions } from "../permissions.ts";

const cwd = "/work", home = "/home/fixture", scratchpad = "/scratch";
const allowance = (data) => parsePermissions(typeof data === "string" ? data : JSON.stringify(data), cwd, home);
const call = (toolName, input = {}) => ({ toolName, input, cwd, home, scratchpad });
const planning = allowance({ networkAccess: "fetch-only" });
const broad = allowance({ writableLocations: ["/work"], networkAccess: "full", socketAccess: ["/run"], displayAccess: true, sessionBusAccess: true, processAccess: "signalling", deviceAccess: "full", tools: ["deploy"] });

test("intersection preserves the stricter grant in every dimension without mutating the originals", () => {
	const before = structuredClone([broad, planning]);
	assert.deepEqual(intersectAllowance(broad, planning), planning);
	assert.deepEqual(intersectAllowance(planning, broad), planning);
	assert.deepEqual(intersectAllowance(planning, allowance("read-only")), allowance("read-only"));
	assert.deepEqual([broad, planning], before);
	const narrow = allowance({ writableLocations: ["/work/src"], socketAccess: ["/run/socket"], networkAccess: "disable", tools: ["deploy", "extra"] });
	const common = intersectAllowance(broad, narrow);
	assert.deepEqual(common.policy.writable, ["/work/src"]);
	assert.deepEqual(common.policy.sockets, ["/run/socket"]);
	assert.deepEqual(common.tools, ["deploy"]);
});

test("an unrestricted base cannot bypass the ceiling", () => {
	const skip = allowance({ dangerouslySkipSandbox: true });
	assert.deepEqual(intersectAllowance(skip, planning), planning);
	assert.deepEqual(intersectAllowance(planning, skip), planning);
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	assert.deepEqual(limits.effective(skip), planning);
	assert.match(limits.denial(call("bash", { sandbox: { dangerouslySkipSandbox: true } })), /temporary restriction/);
});

test("all shell privilege dimensions and unknown tools are denied above the ceiling", () => {
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	for (const sandbox of [
		{ writableLocations: [cwd] }, { networkAccess: "full" }, { socketAccess: ["/run/test"] },
		{ displayAccess: true }, { sessionBusAccess: true }, { deviceAccess: "gpu" },
		{ processAccess: "signalling" }, { dangerouslySkipSandbox: true },
	]) {
		for (const tool of ["bash", "job_start"]) assert.match(limits.denial(call(tool, { command: "unused", sandbox })), /plan mode/);
	}
	assert.match(limits.denial(call("deploy")), /deploy/);
	assert.match(limits.denial(call("write", { path: "/work/a" })), /write/);
	assert.match(limits.denial(call("edit", { path: "/work/a" })), /write/);
});

test("reads, planning tools, scratchpad writes, and declared fetches remain within the ceiling", () => {
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	for (const tool of ["read", "grep", "find", "ls", "job_watch", "job_stop", "enter_plan_mode", "ask_question", "exit_plan_mode"]) {
		assert.equal(limits.denial(call(tool)), undefined);
		assert.equal(assessCall(allowance("read-only"), call(tool)).kind, "allow");
	}
	for (const tool of ["edit", "write"]) assert.equal(limits.denial(call(tool, { path: "/scratch/plan.md" })), undefined);
	for (const tool of ["bash", "job_start"]) {
		assert.equal(limits.denial(call(tool, { command: "unused" })), undefined);
		assert.equal(limits.denial(call(tool, { command: "unused", sandbox: { networkAccess: "fetch-only", writableLocations: ["/scratch/probes"] } })), undefined);
	}
});

test("subagent special-casing cannot escape a temporary ceiling", () => {
	const launch = call("job_start", { command: 'pi -p --permissions read-only "investigate"', sandbox: { dangerouslySkipSandbox: true } });
	assert.equal(assessCall(planning, launch).kind, "allow", "The ordinary pre-approval path permits a bounded child");
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	assert.match(limits.denial(launch), /dangerouslySkipSandbox/);
});

test("ceiling limits do not pre-approve access missing from the base allowance", () => {
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	const request = call("bash", { sandbox: { networkAccess: "fetch-only" } });
	assert.equal(limits.denial(request), undefined);
	assert.equal(assessCall(limits.effective(allowance("read-only")), request).kind, "review");
});

test("release handles stack independently, are idempotent, and never restore an old base snapshot", () => {
	let changes = 0;
	const limits = new PermissionCeilings(() => changes++);
	const releasePlan = limits.add("plan mode", planning);
	const releaseOther = limits.add("another scope", allowance("read-only"));
	assert.equal(changes, 2);
	assert.deepEqual(limits.names, ["plan mode", "another scope"]);
	releasePlan(); releasePlan();
	assert.equal(changes, 3);
	assert.equal(limits.effective(broad).policy.network, "disable");
	const newlyEditedBase = allowance({ writableLocations: ["/new"], networkAccess: "fetch-only" });
	releaseOther();
	assert.deepEqual(limits.effective(newlyEditedBase), newlyEditedBase);
	assert.equal(limits.denial(call("deploy")), undefined);
});

test("stale release cannot remove a newer same-name restriction", () => {
	const limits = new PermissionCeilings(() => {});
	const old = limits.add("plan mode", planning);
	const current = limits.add("plan mode", planning);
	old(); old();
	assert.deepEqual(limits.names, ["plan mode"]);
	assert.match(limits.denial(call("bash", { sandbox: { networkAccess: "full" } })), /plan mode/);
	current();
	assert.deepEqual(limits.names, []);
});

test("malformed declarations are rejected before review", () => {
	const limits = new PermissionCeilings(() => {});
	limits.add("plan mode", planning);
	assert.match(limits.denial(call("bash", { sandbox: { typo: true } })), /Unknown sandbox field/);
	assert.match(limits.denial(call("edit", {})), /needs a path/);
});
