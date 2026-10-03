import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Isolate the job root before the engine computes it.
const base = mkdtempSync(join(homedir(), ".cache", "pi-jobs-test-"));
process.env.TMPDIR = base;
const { describeStatus, getJob, groupAlive, listJobs, readTail, readTailSeed, registry, rootDir, startJob } = await import("../jobs.ts");

const shell = { shell: "/bin/sh", args: ["-c"], commandTransport: "args" };

function start(command, options = {}) {
	return startJob({ command, cwd: base, shell, ...options });
}

async function waitFor(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor timed out");
}

test.after(() => {
	rmSync(base, { recursive: true, force: true });
});

test("runs a command to completion and writes its companion files", async () => {
	const job = await start("printf 'hello\\n'; printf 'oops\\n' >&2; sleep 0.1; printf 'bye\\n'");
	job.detach();
	const status = await job.done;
	assert.equal(status.code, 0);
	assert.equal(status.timedOut, false);
	assert.equal(job.running, false);
	assert.equal(readTail(job.stdoutPath, 10), "hello\nbye");
	assert.equal(dirname(job.stdoutPath), join(base, "pi-jobs", job.id));
	assert.equal(statSync(job.dir).mode & 0o777, 0o700);
	assert.equal(statSync(join(base, "pi-jobs")).mode & 0o1777, 0o1777, "shared root is sticky and world-writable");

	assert.equal(readFileSync(job.pgidPath, "utf8").trim(), String(job.pid));
	assert.equal(readFileSync(job.commandPath, "utf8").trim(), job.command);
	assert.match(readFileSync(job.startedPath, "utf8"), /^\d{4}-\d\d-\d\dT/);
	assert.match(readFileSync(job.stderrPath, "utf8"), /oops/);
	await waitFor(() => existsSync(job.statusPath));
	assert.match(readFileSync(job.statusPath, "utf8"), /exit 0/);

	assert.equal(getJob(job.id), job);
	assert.ok(listJobs().includes(job));
});

test("kills a process group with SIGKILL", async () => {
	const job = await start("sleep 30");
	job.detach();
	job.kill();
	const status = await job.done;
	assert.equal(status.signal, "SIGKILL");
	assert.equal(groupAlive(job.pid), false);
});

test("sends a signal to the process group", async () => {
	const job = await start("trap 'echo caught; exit 0' TERM; sleep 30");
	job.detach();
	await new Promise((resolve) => setTimeout(resolve, 100));
	job.signal("SIGTERM");
	const status = await job.done;
	assert.equal(status.code, 0);
	assert.equal(readTail(job.stdoutPath, 10), "caught");
});

test("kills a job after its timeout", async () => {
	const job = await start("sleep 30", { timeoutSeconds: 0.2 });
	job.detach();
	const status = await job.done;
	assert.equal(status.timedOut, true);
	assert.equal(groupAlive(job.pid), false);
});

test("readTail returns the last lines and tolerates a missing file", () => {
	const path = join(base, "tail.txt");
	writeFileSync(path, "a\nb\nc\nd\n");
	assert.equal(readTail(path, 2), "c\nd");
	assert.equal(readTail(join(base, "missing.txt"), 2), "");
});

test("readTailSeed keeps recent complete lines, holds the partial, and reports the resume offset", () => {
	const path = join(base, "seed.txt");
	writeFileSync(path, "a\nb\nc\npart");
	const seed = readTailSeed(path, 2);
	assert.deepEqual(seed.seedLines, ["b", "c"]);
	assert.equal(seed.partial, "part");
	assert.equal(seed.offset, statSync(path).size);

	// A file ending on a newline has no held partial.
	writeFileSync(path, "a\nb\n");
	assert.deepEqual(readTailSeed(path, 5), { seedLines: ["a", "b"], partial: "", offset: statSync(path).size });

	// A missing file seeds nothing and resumes at the start.
	assert.deepEqual(readTailSeed(join(base, "missing.txt"), 2), { seedLines: [], partial: "", offset: 0 });
});

test("describeStatus covers exit codes and signals", () => {
	assert.equal(describeStatus({ code: 0, signal: null, timedOut: false, leftRunning: false }), "exit 0");
	assert.equal(describeStatus({ code: null, signal: "SIGTERM", timedOut: false, leftRunning: false }), "killed by SIGTERM");
});

test("cleanup removes each job directory as a unit, leaving nothing scattered", async () => {
	const job = await start("printf 'done\\n'");
	job.detach();
	await job.done;
	await waitFor(() => existsSync(job.statusPath));

	const root = rootDir();
	// Files live inside their job directory; the shared root holds directories only.
	assert.equal(readdirSync(root).every((name) => statSync(join(root, name)).isDirectory()), true);
	assert.equal(job.stdoutPath.startsWith(job.dir + "/"), true);

	registry.onExit();
	assert.equal(existsSync(job.dir), false, "job directory removed as a unit");
	assert.equal(existsSync(root), false, "shared root removed once empty");
});
