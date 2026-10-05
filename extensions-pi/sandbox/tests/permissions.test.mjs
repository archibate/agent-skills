import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assessCall,
	describeAllowance,
	excessGrants,
	isAllowance,
	NO_ACCESS,
	parsePermissions,
	presetAllowance,
	unionAllowance,
	workspaceRoot,
} from "../permissions.ts";
import { resolvePolicy } from "../policy.ts";

const home = "/home/u";
const cwd = "/work";
const policy = (request) => resolvePolicy(request, cwd, home);
const assess = (allowance, toolName, input, scratchpad) =>
	assessCall(allowance, { toolName, input, cwd, home, scratchpad });

function tempRepo(t) {
	const base = mkdtempSync(join(tmpdir(), "pi-permissions-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(base, "repo", ".git", "hooks"), { recursive: true });
	writeFileSync(join(base, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
	mkdirSync(join(base, "repo", "src"));
	mkdirSync(join(base, "plain"));
	return base;
}

test("presets: default makes the git work tree writable with fetch-only network; read-only grants nothing", (t) => {
	const base = tempRepo(t);
	const inRepo = presetAllowance("default", join(base, "repo", "src"), home);
	assert.equal(workspaceRoot(join(base, "repo", "src"), home), join(base, "repo"));
	mkdirSync(join(base, "plain", ".git"));
	assert.equal(workspaceRoot(join(base, "plain"), home), undefined, "an empty .git directory is not a repository");
	assert.equal(workspaceRoot(join(base, "repo", "src"), join(base, "repo")), undefined, "home never counts");
	assert.deepEqual(inRepo.policy.writable, [join(base, "repo")]);
	assert.equal(inRepo.policy.network, "fetch-only");
	assert.equal(inRepo.tools, "all");
	assert.deepEqual(presetAllowance("default", join(base, "plain"), home).policy.writable, [], "no git, no workspace write");
	const readOnly = presetAllowance("read-only", base, home);
	assert.deepEqual(readOnly.policy, resolvePolicy({}, base, home));
	assert.deepEqual(readOnly.tools, []);
});

test("parsePermissions accepts presets or a JSON sandbox object with optional tools", () => {
	assert.deepEqual(parsePermissions(" read-only ", cwd, home), presetAllowance("read-only", cwd, home));
	const custom = parsePermissions('{"writableLocations":["src"],"networkAccess":"full","tools":["web_search"]}', cwd, home);
	assert.deepEqual(custom.policy.writable, ["/work/src"]);
	assert.equal(custom.policy.network, "full");
	assert.deepEqual(custom.tools, ["web_search"]);
	assert.throws(() => parsePermissions("readonly", cwd, home), /must be "default" or "read-only", or a JSON sandbox object/);
	assert.throws(() => parsePermissions('{"writable":["src"]}', cwd, home), /Unknown sandbox field writable/);
	assert.throws(() => parsePermissions('{"tools":"all"}', cwd, home), /"tools" must be an array/);
	assert.throws(() => parsePermissions("[]", cwd, home), /JSON must be an object/);
});

test("excessGrants lists every grant beyond the allowance", () => {
	const allowance = policy({ writableLocations: ["/work/src"], networkAccess: "fetch-only", socketAccess: ["/run/s"] });
	assert.deepEqual(excessGrants(policy({}), allowance), []);
	assert.deepEqual(
		excessGrants(policy({ writableLocations: ["/work/src/a"], networkAccess: "fetch-only", socketAccess: ["/run/s/x"] }), allowance),
		[],
	);
	assert.deepEqual(
		excessGrants(
			policy({
				writableLocations: ["/work", "/work/src/a"],
				networkAccess: "full",
				socketAccess: ["/run/t"],
				sessionBusAccess: true,
				displayAccess: true,
				processAccess: "signalling",
				deviceAccess: "gpu",
			}),
			allowance,
		),
		[
			"writableLocations /work",
			'networkAccess "full"',
			"socketAccess /run/t",
			"sessionBusAccess",
			"displayAccess",
			'processAccess "signalling"',
			'deviceAccess "gpu"',
		],
	);
	assert.deepEqual(excessGrants(policy({ dangerouslySkipSandbox: true }), allowance), ["dangerouslySkipSandbox"]);
	assert.deepEqual(excessGrants(policy({ writableLocations: ["/s/x"] }), allowance, "/s"), [], "the scratchpad is always writable");
	assert.deepEqual(excessGrants(policy({ dangerouslySkipSandbox: true }), policy({ dangerouslySkipSandbox: true })), []);
});

test("assessCall: read tools and fitting declarations run; the rest needs review with an always grant", () => {
	const readOnly = presetAllowance("read-only", cwd, home);
	for (const tool of ["read", "grep", "find", "ls", "job_watch", "job_stop"]) assert.deepEqual(assess(readOnly, tool, {}), { kind: "allow" });
	assert.deepEqual(assess(readOnly, "bash", { command: "git log", sandbox: null, timeout: null }), { kind: "allow" });
	assert.deepEqual(assess(readOnly, "job_start", { command: "make", sandbox: {} }), { kind: "allow" });

	const bash = assess(readOnly, "bash", { command: "x", sandbox: { writableLocations: ["."], networkAccess: "full" } });
	assert.equal(bash.kind, "review");
	assert.equal(bash.subject, "bash");
	assert.deepEqual(bash.excess, ["writableLocations /work", 'networkAccess "full"']);
	assert.deepEqual(bash.always.policy.writable, ["/work"]);

	assert.deepEqual(assess(readOnly, "bash", { command: "x", sandbox: { bogus: 1 } }).kind, "invalid");
	const write = assess(readOnly, "write", { path: "a.txt", content: "" });
	assert.deepEqual(write.excess, ["write to /work/a.txt"]);
	assert.deepEqual(write.always.policy.writable, ["/work"], "always pre-approves the file's directory");
	assert.equal(assess(readOnly, "write", {}).kind, "invalid");

	const tool = assess(readOnly, "mcp_search", {});
	assert.deepEqual(tool.excess, ["tool mcp_search"]);
	assert.deepEqual(tool.always.tools, ["mcp_search"]);
	assert.deepEqual(assess(unionAllowance(readOnly, tool.always), "mcp_search", {}), { kind: "allow" });
	assert.deepEqual(assess(presetAllowance("default", cwd, home), "mcp_search", {}), { kind: "allow" });

	const skip = parsePermissions('{"dangerouslySkipSandbox":true}', cwd, home);
	assert.deepEqual(assess(skip, "write", { path: "/etc/x" }), { kind: "allow" }, "skip turns review off");
	assert.deepEqual(assess(skip, "mcp_search", {}), { kind: "allow" });
});

test("write/edit: writable locations and the scratchpad are pre-approved; git control files never are", (t) => {
	const base = tempRepo(t);
	const repo = join(base, "repo");
	const allowance = parsePermissions(JSON.stringify({ writableLocations: [repo] }), base, home);
	const edit = (path, scratchpad) => assessCall(allowance, { toolName: "edit", input: { path }, cwd: base, home, scratchpad });
	assert.deepEqual(edit("repo/src/new.ts"), { kind: "allow" });
	assert.deepEqual(edit(join(base, "pad", "notes.md"), join(base, "pad")), { kind: "allow" });
	assert.equal(edit("other.txt").kind, "review");
	assert.equal(edit("repo/../other.txt").kind, "review");
	for (const path of ["repo/.git/hooks/pre-commit", "repo/.git/config"]) {
		const review = edit(path);
		assert.match(review.excess[0], /^git control file /);
		assert.equal(review.always, undefined, "no always for git control files");
	}
});

test("job_start of a bounded pi subagent is assessed as its --permissions", (t) => {
	const base = tempRepo(t);
	const parent = parsePermissions(JSON.stringify({ writableLocations: [join(base, "repo")] }), base, home);
	const launch = (command) =>
		assessCall(parent, { toolName: "job_start", input: { command, sandbox: { dangerouslySkipSandbox: true } }, cwd: base, home });
	assert.deepEqual(launch('pi -p --permissions read-only "review"'), { kind: "allow" });
	assert.deepEqual(launch(`cd repo && pi -p --permissions '{"writableLocations":["src"]}' "fix"`), { kind: "allow" });
	const wider = launch(`pi -p --permissions '{"writableLocations":["plain"]}' "x"`);
	assert.equal(wider.subject, `subagent launch with --permissions {"writableLocations":["plain"]}`);
	assert.deepEqual(wider.excess, [`writableLocations ${join(base, "plain")}`]);
	assert.deepEqual(launch('pi -p --permissions default "x"').excess, ['networkAccess "fetch-only"', "every other tool"]);
	assert.equal(launch('pi -p --permissions bogus "x"').kind, "invalid");
	assert.deepEqual(launch('pi -p "x"').excess, ["dangerouslySkipSandbox"], "no --permissions: plain skip review");
	assert.deepEqual(launch("pi -p --permissions read-only --reviewer manual x").excess, ["dangerouslySkipSandbox"]);
});

test("unionAllowance, isAllowance, describeAllowance", () => {
	const a = parsePermissions('{"writableLocations":["a"],"networkAccess":"fetch-only","tools":["x"]}', cwd, home);
	const b = parsePermissions('{"writableLocations":["b"],"processAccess":"signalling","tools":["y"]}', cwd, home);
	const u = unionAllowance(a, b);
	assert.deepEqual(u.policy.writable, ["/work/a", "/work/b"]);
	assert.equal(u.policy.network, "fetch-only");
	assert.equal(u.policy.process, "signalling");
	assert.deepEqual(u.tools, ["x", "y"]);
	assert.deepEqual(unionAllowance(NO_ACCESS, a), a);
	assert.equal(isAllowance(u), true);
	assert.equal(isAllowance({ policy: { ...u.policy, network: "some" }, tools: [] }), false);
	assert.equal(isAllowance(null), false);
	assert.equal(describeAllowance(u), "write /work/a, /work/b · net fetch-only · proc signalling · tools x, y");
	assert.equal(describeAllowance(presetAllowance("read-only", cwd, home)), "read-only");
});
