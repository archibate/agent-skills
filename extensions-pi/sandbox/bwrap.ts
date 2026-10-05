/**
 * Pure translation of a resolved policy plus host facts into a bwrap command line and a child
 * environment. No I/O: host.ts gathers the facts, so every decision is unit-testable.
 *
 * Two layers:
 * - bwrap mounts: read-only root (host /tmp stays readable), a private writable tmpfs on /var/tmp
 *   that becomes TMPDIR, writable binds, and network/PID namespaces. /tmp itself is not replaced:
 *   re-exposing hundreds of host /tmp entries over a private /tmp costs ~1ms of mount work each.
 * - landlock-exec, the sandbox entry point: denies connecting to any host Unix socket (pathname
 *   or abstract) except the granted ones, and with signal scoping denies signalling host
 *   processes. A read-only bind does not stop connect(), so this layer is what closes IPC
 *   escapes such as tmux send-keys, nvim --remote-send, D-Bus, or agent daemons.
 */

import { join } from "node:path";
import type { SandboxPolicy } from "./policy.ts";

/** Set inside every sandbox. Nesting is impossible: Landlock forbids the mounts bwrap needs. */
export const NESTED_MARKER = "PI_SANDBOX";
/** Private temporary directory inside the sandbox, exported as TMPDIR. */
export const SANDBOX_TMPDIR = "/var/tmp";
/** Inside the private TMPDIR: the read-only root has no writable place for a new mount point. */
export const PROXY_SOCKET_IN_SANDBOX = `${SANDBOX_TMPDIR}/.pi-sandbox-proxy.sock`;
export const PROXY_PORT = 3128;
const TMP_SIZE_BYTES = 4 * 1024 * 1024 * 1024;

export interface HostFacts {
	/** Built landlock-exec helper. */
	landlockExec: string;
	/** Session scratchpad; always writable. */
	scratchpad?: string;
	/** systemd-resolved directory; its varlink socket is allowed only with full network. */
	resolverDir?: string;
	busSockets: string[];
	displaySockets: string[];
	gpuDevices: string[];
	/** Host path of this call's fetch-only proxy socket. */
	proxySocket?: string;
}

export interface SandboxCommand {
	bwrapArgs: string[];
	/** Entry point inside the sandbox; the shell command follows. */
	entry: string[];
}

export function buildSandboxCommand(policy: SandboxPolicy, facts: HostFacts, cwd: string): SandboxCommand {
	const args = ["--die-with-parent", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL"];
	args.push("--ro-bind", "/", "/");

	if (policy.device === "full") {
		args.push("--dev-bind", "/dev", "/dev");
	} else {
		args.push("--dev", "/dev");
		if (policy.device === "gpu") for (const device of facts.gpuDevices) args.push("--dev-bind-try", device, device);
	}

	// "visibility" and "signalling" share the host PID namespace; Landlock scoping is what keeps
	// "visibility" from signalling host processes. A separate PID namespace with the host /proc
	// would break procps, which looks itself up by its namespaced PID.
	if (policy.process === "disable") args.push("--unshare-pid", "--proc", "/proc");

	if (policy.network !== "full") args.push("--unshare-net");

	args.push("--size", String(TMP_SIZE_BYTES), "--tmpfs", SANDBOX_TMPDIR);

	const writable = facts.scratchpad ? [facts.scratchpad, ...policy.writable] : [...policy.writable];
	for (const path of writable) args.push("--bind", path, path);
	// A writable repository must not gain hooks or config that later run outside the sandbox.
	for (const root of policy.writable) {
		for (const path of [join(root, ".git", "hooks"), join(root, ".git", "config")]) {
			args.push("--ro-bind-try", path, path);
		}
	}

	const allowUnix: string[] = [...policy.sockets];
	if (policy.bus) allowUnix.push(...facts.busSockets);
	if (policy.display) allowUnix.push(...facts.displaySockets);
	if (policy.network === "full" && facts.resolverDir) allowUnix.push(facts.resolverDir);
	if (policy.network === "fetch-only") {
		if (!facts.proxySocket) throw new Error("fetch-only network requires a proxy socket");
		args.push("--ro-bind", facts.proxySocket, PROXY_SOCKET_IN_SANDBOX);
		allowUnix.push(PROXY_SOCKET_IN_SANDBOX);
	}

	args.push("--chdir", cwd);

	const entry = [facts.landlockExec];
	if (policy.process !== "signalling") entry.push("--scope-signal");
	for (const path of allowUnix) entry.push("--allow-unix", path);
	entry.push("--");
	return { bwrapArgs: args, entry };
}

/**
 * Inside the sandbox, start a TCP->Unix relay to the fetch-only proxy, wait until it listens, then
 * run the real shell (passed as "$@") and stop the relay. Used as `bash -c PRELUDE name shell...`.
 */
export const PROXY_PRELUDE = [
	`socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${PROXY_SOCKET_IN_SANDBOX} 2>/dev/null &`,
	"__pi_relay=$!",
	"__pi_i=0",
	`until (exec 3<>/dev/tcp/127.0.0.1/${PROXY_PORT}) 2>/dev/null; do`,
	"  __pi_i=$((__pi_i + 1)); [ $__pi_i -ge 500 ] && break; sleep 0.01",
	"done",
	'"$@"',
	"__pi_rc=$?",
	'kill "$__pi_relay" 2>/dev/null',
	'exit "$__pi_rc"',
].join("\n");

const PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"];
const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "NIRI_SOCKET", "SWAYSOCK", "I3SOCK", "HYPRLAND_INSTANCE_SIGNATURE"];
const BUS_VARS = ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS"];
/** Variables naming a host IPC endpoint; kept only when that endpoint was granted via socketAccess. */
const SOCKET_VARS = [
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GPG_AGENT_INFO",
	"TMUX",
	"TMUX_PANE",
	"KITTY_LISTEN_ON",
	"NVIM",
	"NVIM_LISTEN_ADDRESS",
	"WEZTERM_UNIX_SOCKET",
];

/** Drop variables pointing at hidden endpoints, so tools fail fast instead of probing them. */
export function sandboxEnv(policy: SandboxPolicy, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const drop = (name: string) => {
		delete env[name];
		delete env[name.toUpperCase()];
	};
	if (!policy.display) for (const name of DISPLAY_VARS) drop(name);
	if (!policy.bus) for (const name of BUS_VARS) drop(name);
	for (const name of SOCKET_VARS) {
		const value = env[name];
		if (value !== undefined && !policy.sockets.some((socket) => value.includes(socket))) delete env[name];
	}
	for (const name of ["TMPDIR", "TMP", "TEMP"]) env[name] = SANDBOX_TMPDIR;
	env[NESTED_MARKER] = "1";
	if (policy.network !== "full") for (const name of PROXY_VARS) drop(name);
	if (policy.network === "fetch-only") {
		const url = `http://127.0.0.1:${PROXY_PORT}`;
		for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
			env[name] = url;
			env[name.toUpperCase()] = url;
		}
		env.NODE_USE_ENV_PROXY = "1";
	}
	return env;
}
