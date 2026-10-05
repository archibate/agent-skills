import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSandboxCommand, PROXY_SOCKET_IN_SANDBOX, SANDBOX_TMPDIR, sandboxEnv } from "../bwrap.ts";
import { canonicalPath, describeRequest, isReadOnlyRequest, resolvePolicy } from "../policy.ts";

const facts = {
	landlockExec: "/cache/landlock-exec",
	scratchpad: "/scratch",
	resolverDir: "/run/systemd/resolve",
	busSockets: ["/run/user/1000/bus", "/run/dbus/system_bus_socket"],
	displaySockets: ["/tmp/.X11-unix", "/run/user/1000/wayland-1"],
	gpuDevices: ["/dev/dri", "/dev/nvidia0"],
};

const policy = (request) => resolvePolicy(request, "/work", "/home/u");

/** Index of the argv triple `flag a b`, or -1. */
function indexOfTriple(args, flag, a, b) {
	for (let i = 0; i + 2 < args.length; i++) if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
	return -1;
}

test("defaults are read-only, no network, visible processes, no devices", () => {
	assert.deepEqual(policy(undefined), {
		skip: false,
		writable: [],
		network: "disable",
		sockets: [],
		bus: false,
		display: false,
		process: "visibility",
		device: "none",
	});
	assert.equal(isReadOnlyRequest(undefined), true);
	assert.equal(isReadOnlyRequest({ processAccess: "disable" }), true);
	assert.equal(isReadOnlyRequest({ networkAccess: "fetch-only" }), false);
});

test("paths expand ~ and cwd, dedupe, and reject /", () => {
	const p = policy({ writableLocations: ["~/.cache/uv", "out", "/work/out"] });
	assert.deepEqual(p.writable, ["/home/u/.cache/uv", "/work/out"]);
	assert.throws(() => policy({ writableLocations: ["/"] }), /cannot include "\/"/);
	assert.throws(() => policy({ writableLocations: [""] }), /non-empty/);
	assert.throws(() => policy({ networkAccess: "some" }), /networkAccess must be one of/);
});

test("raw requests are validated: unknown fields, wrong types, bad enums", () => {
	assert.throws(() => policy({ writeable: ["x"] }), /Unknown sandbox field writeable; the fields are writableLocations,/);
	assert.throws(() => policy({ displayAccess: "yes" }), /sandbox\.displayAccess must be a boolean/);
	assert.throws(() => policy({ networkAccess: "on" }), /sandbox\.networkAccess must be one of/);
	assert.throws(() => policy({ writableLocations: "x" }), /must be an array/);
	assert.throws(() => policy("x"), /sandbox must be an object/);
	assert.deepEqual(policy(null), policy(undefined), "null means omitted");
});

test("canonicalPath resolves symlinks of the existing prefix and keeps the missing rest", (t) => {
	const base = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-unit-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	mkdirSync(join(base, "real"));
	symlinkSync(join(base, "real"), join(base, "link"));
	assert.equal(canonicalPath(join(base, "link", "new", "deeper")), join(base, "real", "new", "deeper"));
});

test("default command: read-only root, private TMPDIR, scratchpad, landlock with signal scope", () => {
	const { bwrapArgs, entry } = buildSandboxCommand(policy(undefined), facts, "/work");
	const at = (flag, a, b) => indexOfTriple(bwrapArgs, flag, a, b);
	assert.ok(at("--ro-bind", "/", "/") >= 0);
	assert.ok(bwrapArgs.includes("--unshare-net"));
	assert.ok(!bwrapArgs.includes("--unshare-pid"), "visibility keeps the host PID namespace");
	assert.ok(bwrapArgs.includes("--die-with-parent"));
	const tmpfs = bwrapArgs.findIndex((arg, i) => arg === "--tmpfs" && bwrapArgs[i + 1] === SANDBOX_TMPDIR);
	assert.ok(tmpfs > at("--ro-bind", "/", "/"));
	assert.ok(at("--bind", "/scratch", "/scratch") > at("--ro-bind", "/", "/"));
	assert.deepEqual(bwrapArgs.slice(-2), ["--chdir", "/work"]);
	assert.deepEqual(entry, ["/cache/landlock-exec", "--scope-signal", "--"]);
});

test("writable repository roots keep .git hooks and config read-only, after the writable bind", () => {
	const { bwrapArgs } = buildSandboxCommand(policy({ writableLocations: ["/work"] }), facts, "/work");
	const bind = indexOfTriple(bwrapArgs, "--bind", "/work", "/work");
	assert.ok(bind >= 0);
	assert.ok(indexOfTriple(bwrapArgs, "--ro-bind-try", "/work/.git/hooks", "/work/.git/hooks") > bind);
	assert.ok(indexOfTriple(bwrapArgs, "--ro-bind-try", "/work/.git/config", "/work/.git/config") > bind);
});

test("grants map to namespaces, devices, and landlock socket allowances", () => {
	const full = buildSandboxCommand(
		policy({ networkAccess: "full", processAccess: "signalling", deviceAccess: "full", sessionBusAccess: true }),
		facts,
		"/work",
	);
	assert.ok(!full.bwrapArgs.includes("--unshare-net"));
	assert.ok(indexOfTriple(full.bwrapArgs, "--dev-bind", "/dev", "/dev") >= 0);
	assert.deepEqual(full.entry, [
		"/cache/landlock-exec",
		"--allow-unix",
		"/run/user/1000/bus",
		"--allow-unix",
		"/run/dbus/system_bus_socket",
		"--allow-unix",
		"/run/systemd/resolve",
		"--",
	]);

	const isolated = buildSandboxCommand(policy({ processAccess: "disable", deviceAccess: "gpu", displayAccess: true }), facts, "/w");
	assert.ok(isolated.bwrapArgs.includes("--unshare-pid"));
	assert.ok(indexOfTriple(isolated.bwrapArgs, "--dev-bind-try", "/dev/nvidia0", "/dev/nvidia0") >= 0);
	assert.ok(isolated.entry.includes("/tmp/.X11-unix"));
	assert.ok(!isolated.entry.includes("/run/systemd/resolve"), "resolver socket only with full network");

	const sockets = buildSandboxCommand(policy({ socketAccess: ["/tmp/tmux-1000/default"] }), facts, "/w");
	assert.deepEqual(sockets.entry.slice(1), ["--scope-signal", "--allow-unix", "/tmp/tmux-1000/default", "--"]);
});

test("fetch-only binds and allows the proxy socket, and requires one", () => {
	const p = policy({ networkAccess: "fetch-only" });
	assert.throws(() => buildSandboxCommand(p, facts, "/w"), /proxy socket/);
	const { bwrapArgs, entry } = buildSandboxCommand(p, { ...facts, proxySocket: "/rt/proxy.sock" }, "/w");
	assert.ok(bwrapArgs.includes("--unshare-net"));
	assert.ok(indexOfTriple(bwrapArgs, "--ro-bind", "/rt/proxy.sock", PROXY_SOCKET_IN_SANDBOX) > bwrapArgs.indexOf(SANDBOX_TMPDIR));
	assert.ok(entry.includes(PROXY_SOCKET_IN_SANDBOX));
});

test("environment drops hidden endpoints and points proxies at the relay", () => {
	const base = {
		PATH: "/usr/bin",
		DISPLAY: ":1",
		WAYLAND_DISPLAY: "wayland-1",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
		TMUX: "/tmp/tmux-1000/default,1,0",
		SSH_AUTH_SOCK: "/run/user/1000/ssh",
		http_proxy: "http://127.0.0.1:7890",
		HTTPS_PROXY: "http://127.0.0.1:7890",
		no_proxy: "localhost",
	};
	const plain = sandboxEnv(policy(undefined), base);
	assert.equal(plain.PATH, "/usr/bin");
	assert.equal(plain.TMPDIR, SANDBOX_TMPDIR);
	assert.equal(plain.PI_SANDBOX, "1");
	for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "TMUX", "SSH_AUTH_SOCK", "http_proxy", "HTTPS_PROXY", "no_proxy"]) {
		assert.equal(plain[name], undefined, name);
	}
	const granted = sandboxEnv(policy({ socketAccess: ["/tmp/tmux-1000/default"], displayAccess: true, networkAccess: "full" }), base);
	assert.equal(granted.TMUX, base.TMUX);
	assert.equal(granted.DISPLAY, ":1");
	assert.equal(granted.http_proxy, base.http_proxy);
	const fetch = sandboxEnv(policy({ networkAccess: "fetch-only" }), base);
	assert.equal(fetch.https_proxy, "http://127.0.0.1:3128");
	assert.equal(fetch.HTTP_PROXY, "http://127.0.0.1:3128");
	assert.equal(fetch.no_proxy, undefined);
	assert.equal(fetch.NODE_USE_ENV_PROXY, "1");
});

test("badge summarizes grants with escape-grade ones as warnings", () => {
	assert.deepEqual(describeRequest(undefined), [{ text: "read-only", tone: "muted" }]);
	assert.deepEqual(describeRequest({ dangerouslySkipSandbox: true, writableLocations: ["/x"] }), [{ text: "UNSANDBOXED", tone: "warning" }]);
	const parts = describeRequest({ writableLocations: ["~/.cache/uv"], networkAccess: "full", displayAccess: true });
	assert.deepEqual(parts, [
		{ text: "rw ~/.cache/uv", tone: "accent" },
		{ text: "net FULL", tone: "warning" },
		{ text: "display", tone: "warning" },
	]);
	// Partial (streaming) arguments render without throwing.
	assert.deepEqual(describeRequest({ writableLocations: "not-an-array" }), [{ text: "read-only", tone: "muted" }]);
});
