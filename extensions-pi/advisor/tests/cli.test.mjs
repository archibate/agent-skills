import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const execute = promisify(execFile);
const pairings = { "advisor-test/cheap": "advisor-test/reviewer", "advisor-test/frontier": null };

async function cli({ model = "advisor-test/cheap", override, config, extra = [] } = {}) {
	const root = mkdtempSync(join(f.scratch, "cli-"));
	const home = join(root, "home"); const agentDir = join(home, "agent"); const cwd = join(root, "workspace");
	mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd);
	const path = join(agentDir, "advisor.json");
	if (config !== undefined) writeFileSync(path, config);
	// A project-local pairing must not authorize forwarding to another provider.
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/advisor.json"), JSON.stringify({ pairings }));
	const flags = ["--no-extensions", "-e", join(f.scratch, "extension/tests/cli-fixture.ts"), "-e", join(f.scratch, "extension/index.ts"),
		"--offline", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-session", "--no-approve",
		"--mode", "json", "--system-prompt", "Offline fixture.", "--model", model, ...extra];
	if (override !== undefined) flags.push("--advisor", override);
	const child = execute(process.execPath, [join(f.host, "dist/cli.js"), ...flags, "Fixture."], {
		cwd, timeout: 20_000, maxBuffer: 1024 * 1024,
		env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false", ADVISOR_TEST_KEY: "synthetic", TERM: "dumb" },
	});
	child.child.stdin.end(); // Pi waits for EOF before combining piped input with the prompt.
	const { stdout, stderr } = await child;
	assert.equal(existsSync(path), config !== undefined, "Starting Pi must not create advisor.json");
	if (config !== undefined) assert.equal(readFileSync(path, "utf8"), config, "Overrides must not rewrite pairings");
	const events = stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
	const last = events.findLast((event) => event.type === "message_end" && event.message.role === "assistant");
	assert.ok(last, `${stdout}\n${stderr}`);
	assert.equal(last.message.stopReason, "stop", JSON.stringify(last));
	return { output: JSON.parse(last.message.content.find((block) => block.type === "text").text), stderr, events };
}

test("CLI --model resolves pairing; missing config and explicit null expose no advisor", { timeout: 70_000 }, async () => {
	const off = await cli();
	assert.deepEqual(off.output.tools, []);
	const on = await cli({ config: JSON.stringify({ pairings }), model: "advisor-test/cheap:low" });
	assert.deepEqual(on.output.tools, ["advisor"]);
	assert.match(JSON.stringify(on.output.review), /REVIEWER:reviewer/);
	const unpaired = await cli({ config: JSON.stringify({ pairings }), model: "advisor-test/frontier" });
	assert.deepEqual(unpaired.output.tools, []);
});

test("CLI --advisor model/none overrides pairing without writing configuration", { timeout: 70_000 }, async () => {
	const overridden = await cli({ config: JSON.stringify({ pairings }), override: "advisor-test/other" });
	assert.match(JSON.stringify(overridden.output.review), /REVIEWER:other/);
	const off = await cli({ config: JSON.stringify({ pairings }), override: "none" });
	assert.deepEqual(off.output.tools, []);
	const direct = await cli({ override: "advisor-test/reviewer", model: "advisor-test/frontier" });
	assert.match(JSON.stringify(direct.output.review), /REVIEWER:reviewer/);
});

test("CLI invalid config fails closed; --advisor none bypasses it and --no-tools remains authoritative", { timeout: 70_000 }, async () => {
	const bad = await cli({ config: "invalid" });
	assert.deepEqual(bad.output.tools, []);
	assert.match(`${bad.stderr}\n${JSON.stringify(bad.events)}`, /Advisor configuration/);
	const bypass = await cli({ config: "invalid", override: "none" });
	assert.deepEqual(bypass.output.tools, []);
	assert.doesNotMatch(`${bypass.stderr}\n${JSON.stringify(bypass.events)}`, /Advisor configuration/);
	const excluded = await cli({ config: JSON.stringify({ pairings }), extra: ["--no-tools"] });
	assert.deepEqual(excluded.output.tools, []);
});
