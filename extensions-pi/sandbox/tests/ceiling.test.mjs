import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ceilingViolation, excessGrants, parseCeiling } from "../ceiling.ts";
import { resolvePolicy } from "../policy.ts";

const home = "/home/u";
const cwd = "/work";
const policy = (request) => resolvePolicy(request, cwd, home);
const call = (ceiling, toolName, input, scratchpad) => ceilingViolation(ceiling, { toolName, input, cwd, home, scratchpad });

test("parseCeiling accepts read-only or a JSON sandbox object, and rejects the rest", () => {
	assert.deepEqual(parseCeiling(" read-only ", cwd, home).policy, policy({}));
	assert.deepEqual(parseCeiling('{"writableLocations":["src"]}', cwd, home).policy.writable, ["/work/src"]);
	assert.throws(() => parseCeiling("readonly", cwd, home), /must be "read-only" or a JSON sandbox object/);
	assert.throws(() => parseCeiling('{"writable":["src"]}', cwd, home), /Unknown sandbox field writable/);
});

test("excessGrants lists every grant beyond the ceiling", () => {
	const ceiling = policy({ writableLocations: ["/work/src"], networkAccess: "fetch-only", socketAccess: ["/run/s"] });
	assert.deepEqual(excessGrants(policy({}), ceiling), []);
	assert.deepEqual(
		excessGrants(policy({ writableLocations: ["/work/src/a", "/work/src"], networkAccess: "fetch-only", socketAccess: ["/run/s/x"] }), ceiling),
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
			ceiling,
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
	assert.deepEqual(excessGrants(policy({ dangerouslySkipSandbox: true }), ceiling), ["dangerouslySkipSandbox"]);
	assert.deepEqual(excessGrants(policy({ writableLocations: ["/s/x"] }), ceiling, "/s"), [], "scratchpad is always writable");
	assert.deepEqual(excessGrants(policy({ dangerouslySkipSandbox: true }), policy({ dangerouslySkipSandbox: true })), []);
});

test("read-only ceiling: read tools and plain bash run; grants, writes, and unknown tools are blocked", () => {
	const ceiling = parseCeiling("read-only", cwd, home);
	for (const tool of ["read", "grep", "find", "ls", "job_watch", "job_stop"]) assert.equal(call(ceiling, tool, {}), undefined);
	assert.equal(call(ceiling, "bash", { command: "git log" }), undefined);
	assert.equal(call(ceiling, "bash", { command: "git log", sandbox: null, timeout: null }), undefined);
	assert.equal(call(ceiling, "job_start", { command: "make", sandbox: {} }), undefined);
	assert.match(
		call(ceiling, "bash", { command: "x", sandbox: { writableLocations: ["."], networkAccess: "full" } }),
		/^Blocked by --sandbox-ceiling read-only: bash declares writableLocations \/work; networkAccess "full"\./,
	);
	assert.match(call(ceiling, "job_start", { command: "pi -p x", sandbox: { dangerouslySkipSandbox: true } }), /declares dangerouslySkipSandbox/);
	assert.match(call(ceiling, "bash", { command: "x", sandbox: { bogus: 1 } }), /Unknown sandbox field bogus/);
	assert.match(call(ceiling, "write", { path: "a.txt", content: "" }), /write of \/work\/a\.txt is outside the writable locations/);
	assert.match(call(ceiling, "mcp_tool", {}), /mcp_tool is not a known read-only tool/);
});

test("write/edit follow the ceiling's writable locations, the scratchpad, and .git protection", (t) => {
	const base = mkdtempSync(join(tmpdir(), "pi-ceiling-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, "repo");
	mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
	const ceiling = parseCeiling(JSON.stringify({ writableLocations: [repo] }), base, home);
	const edit = (path, scratchpad) => ceilingViolation(ceiling, { toolName: "edit", input: { path }, cwd: base, home, scratchpad });
	assert.equal(edit("repo/src/new.ts"), undefined, "relative paths resolve against cwd; missing files are fine");
	assert.equal(edit(join(base, "pad", "notes.md"), join(base, "pad")), undefined);
	assert.match(edit("other.txt"), /outside the writable locations/);
	assert.match(edit("repo/.git/hooks/pre-commit"), /outside the writable locations/);
	assert.match(edit("repo/.git/config"), /outside the writable locations/);
	assert.match(edit("repo/../other.txt"), /outside the writable locations/);
});

test("a dangerouslySkipSandbox ceiling allows everything", () => {
	const ceiling = parseCeiling('{"dangerouslySkipSandbox":true}', cwd, home);
	assert.equal(call(ceiling, "write", { path: "/etc/x" }), undefined);
	assert.equal(call(ceiling, "mcp_tool", {}), undefined);
});
