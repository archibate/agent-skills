import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

// Real bubblewrap + Landlock runs. Everything the tests create lives in one temp directory under
// ~/.cache, including the compiled helper (XDG_CACHE_HOME) and the scratchpad. Host-side fixtures
// (sockets, servers, a sleep process) are owned by this test process.
const hasBwrap = (() => {
	try {
		execFileSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-test-"));
process.env.XDG_CACHE_HOME = join(base, "cache");
process.env.LC_ALL = "C";
process.env.PI_SCRATCHPAD_DIR = join(base, "scratch");
mkdirSync(process.env.PI_SCRATCHPAD_DIR);
const { execShell, prepareSandbox } = await import("../sandbox.ts");

/** Run `command` under `request`; returns { code, out, report }. */
async function run(request, command, { cwd = base, timeout = 20 } = {}) {
	const sandbox = await prepareSandbox(request, cwd);
	let out = "";
	try {
		const result = await execShell(sandbox.shell({ shell: "/usr/bin/bash", args: ["-c"] }), command, cwd, {
			onData: (data) => {
				out += data;
			},
			env: sandbox.env(process.env),
			timeout,
			reapGroup: sandbox.reapGroup,
		});
		return { code: result.exitCode, out, report: sandbox.report() };
	} finally {
		await sandbox.dispose();
	}
}

test("real sandbox", { skip: !hasBwrap }, async (t) => {
	t.after(() => rmSync(base, { recursive: true, force: true }));

	await t.test("read-only by default; scratchpad and TMPDIR writable", async () => {
		const outside = join(base, "outside");
		const { code, out } = await run(
			undefined,
			`touch ${outside} 2>&1; touch "$PI_SCRATCHPAD_DIR/s" && echo scratch-ok; touch "$TMPDIR/t" && echo tmp-ok; echo "tmpdir=$TMPDIR"`,
		);
		assert.equal(code, 0);
		assert.match(out, /Read-only file system/);
		assert.match(out, /scratch-ok/);
		assert.match(out, /tmp-ok/);
		assert.match(out, /tmpdir=\/var\/tmp/);
		assert.equal(existsSync(outside), false);
		assert.equal(existsSync(join(process.env.PI_SCRATCHPAD_DIR, "s")), true);
	});

	await t.test("writableLocations are created, writable, and keep .git hooks/config read-only", async () => {
		const repo = join(base, "repo");
		mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
		writeFileSync(join(repo, ".git", "config"), "[core]\n");
		const fresh = join(base, "fresh", "dir");
		const { out } = await run(
			{ writableLocations: [repo, fresh] },
			`echo x > ${repo}/file && echo repo-ok; echo y > ${fresh}/f && echo fresh-ok; ` +
				`echo z > ${repo}/.git/hooks/pre-commit 2>&1; echo w >> ${repo}/.git/config 2>&1; echo ok > ${repo}/.git/HEAD && echo head-ok`,
		);
		assert.match(out, /repo-ok/);
		assert.match(out, /fresh-ok/);
		assert.match(out, /head-ok/);
		assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
		assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), "[core]\n");
	});

	await t.test("host Unix sockets are unreachable unless granted", async (t) => {
		const dir = join(base, "sock");
		mkdirSync(dir);
		const path = join(dir, "s");
		const server = createServer((socket) => socket.end("pong\n"));
		await new Promise((resolve) => server.listen(path, resolve));
		const abstract = createServer((socket) => socket.end("pong\n"));
		const abstractName = `pi-sandbox-test-${process.pid}`;
		await new Promise((resolve) => abstract.listen(`\0${abstractName}`, resolve));
		t.after(() => {
			server.close();
			abstract.close();
		});

		const probe = `socat - UNIX-CONNECT:${path} </dev/null 2>&1; socat - ABSTRACT-CONNECT:${abstractName} </dev/null 2>&1`;
		const denied = await run({ networkAccess: "full" }, probe);
		assert.doesNotMatch(denied.out, /pong/, "pathname and abstract sockets are denied, even with full network");
		const file = await run({ socketAccess: [path] }, `socat - UNIX-CONNECT:${path} </dev/null`);
		assert.match(file.out, /pong/);
		const directory = await run({ socketAccess: [dir] }, `socat - UNIX-CONNECT:${path} </dev/null`);
		assert.match(directory.out, /pong/);
		// Sockets the sandbox creates itself stay usable.
		const own = await run(
			undefined,
			'socat UNIX-LISTEN:"$TMPDIR/own",fork EXEC:"echo pong" & for i in $(seq 100); do [ -S "$TMPDIR/own" ] && break; sleep 0.02; done; socat - UNIX-CONNECT:"$TMPDIR/own" </dev/null',
		);
		assert.match(own.out, /pong/);
	});

	await t.test("network: disable blocks host loopback; fetch-only blocks local destinations", async (t) => {
		const server = createHttpServer((_req, res) => res.end("secret"));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => server.close());
		const url = `http://127.0.0.1:${server.address().port}/`;
		const disabled = await run(undefined, `curl -sS -m 5 ${url} 2>&1`);
		assert.doesNotMatch(disabled.out, /secret/);
		const fetch = await run({ networkAccess: "fetch-only" }, `curl -sS -m 5 ${url} 2>&1; echo "proxy=$https_proxy"`);
		assert.doesNotMatch(fetch.out, /secret/);
		assert.match(fetch.out, /pi-sandbox fetch-only: 127\.0\.0\.1:\d+ is blocked/);
		assert.match(fetch.out, /proxy=http:\/\/127\.0\.0\.1:3128/);
		assert.equal(fetch.report.network.denied.length, 1);
		const full = await run({ networkAccess: "full" }, `curl -sS -m 5 ${url}`);
		assert.match(full.out, /secret/);
	});

	await t.test("processes: visible but not signallable by default; signalling grant; isolation", async (t) => {
		const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
		t.after(() => sleeper.kill("SIGKILL"));
		const visible = await run(undefined, `ps -p ${sleeper.pid} -o comm=; kill -0 ${sleeper.pid} 2>&1 && echo signalled`);
		assert.match(visible.out, /sleep/);
		assert.doesNotMatch(visible.out, /signalled/);
		const own = await run(undefined, "sleep 30 & kill $! && echo own-ok");
		assert.match(own.out, /own-ok/);
		const granted = await run({ processAccess: "signalling" }, `kill -0 ${sleeper.pid} && echo signalled`);
		assert.match(granted.out, /signalled/);
		const isolated = await run({ processAccess: "disable" }, `ps -e -o pid= | wc -l; ps -p ${sleeper.pid} >/dev/null || echo hidden`);
		assert.match(isolated.out, /hidden/);
		assert.ok(Number(isolated.out.trim().split("\n")[0]) < 10);
	});

	await t.test("background processes end with the command; timeouts kill the sandbox", async () => {
		const marker = `pi-sandbox-bg-${process.pid}`;
		await run(undefined, `bash -c 'exec -a ${marker} sleep 30' & echo started`);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => execFileSync("pgrep", ["-f", marker]), "background process was reaped");
		await assert.rejects(run(undefined, `bash -c 'exec -a ${marker}-t sleep 30'`, { timeout: 1 }), /timeout:1/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => execFileSync("pgrep", ["-f", `${marker}-t`]));
	});

	await t.test("display, D-Bus, and devices stay hidden by default", async () => {
		const { out } = await run(undefined, 'echo "d=$DISPLAY w=$WAYLAND_DISPLAY b=$DBUS_SESSION_BUS_ADDRESS"; ls /dev | wc -l');
		assert.match(out, /d= w= b=\n/);
		assert.ok(Number(out.trim().split("\n").at(-1)) < 20);
	});

	await t.test("dangerouslySkipSandbox runs on the host", async () => {
		const target = join(base, "skipped");
		await run({ dangerouslySkipSandbox: true }, `touch ${target}`);
		assert.equal(existsSync(target), true);
	});
});
