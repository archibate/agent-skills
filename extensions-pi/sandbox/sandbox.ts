/**
 * Shared sandbox API for every tool that runs agent shell commands (`bash`, `job_start`, `/btw`).
 *
 * prepareSandbox() turns a declaration into a ready-to-spawn shell config and environment, plus a
 * per-call fetch-only proxy when requested. The caller spawns `shell(base)` with `env(base)` and
 * calls dispose() once the command (or job) has exited.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxCommand, NESTED_MARKER, PROXY_PRELUDE, type SandboxCommand, sandboxEnv } from "./bwrap.ts";
import { findExecutable, gatherHostFacts, landlockExec, runtimeDir } from "./host.ts";
import type { TSchema } from "typebox";
import { resolvePolicy, type SandboxPolicy, type SandboxRequest } from "./policy.ts";
import { type ProxyHandle, startProxy } from "./proxy.ts";

export {
	describeRequest,
	isReadOnlyRequest,
	type SandboxRequest,
	sandboxReferenceSchema,
	sandboxSchema,
} from "./policy.ts";

/** Model-facing summary appended to the description of every sandboxed shell tool. */
export const SANDBOX_NOTE =
	"Runs in a sandbox: the filesystem is read-only except the session scratchpad and $TMPDIR, with no network and no host sockets, display, or D-Bus. Declare extra access the command needs in `sandbox`.";

/**
 * Private interface between this extension and jobs/btw, which must work without it. They emit a
 * reply callback on this pi.events channel; the loaded sandbox extension answers synchronously.
 * pi.events is per runtime, so a /reload that drops this extension also drops the answer.
 */
export const PROVIDER_CHANNEL = "archibate.sandbox:get";

export interface SandboxProvider {
	/** Appended to the description of a tool whose commands run sandboxed. */
	note: string;
	/** `sandbox` parameter schema for tools declared next to `bash`. */
	parameter: TSchema;
	prepare(request: unknown, cwd: string): Promise<PreparedSandbox>;
	isReadOnly(request: unknown): boolean;
}

export type SandboxProviderReply = (provider: SandboxProvider) => void;

/** Build the landlock-exec helper ahead of the first sandboxed call. */
export function warmSandbox(): void {
	landlockExec().catch(() => {});
}

/** Mirrors pi's ShellConfig. */
export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export interface SandboxReport {
	network?: { hosts: string[]; denied: Array<{ host: string; reason: string }> };
}

export interface PreparedSandbox {
	policy: SandboxPolicy;
	/** Wrap the host shell so the command runs inside bwrap (identity when skipped). */
	shell(base: ShellConfig): ShellConfig;
	/** Child environment for the sandboxed shell. */
	env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	/**
	 * Kill the command's process group once its shell exits, so background processes end with the
	 * command. False when skipped or with processAccess "signalling".
	 */
	reapGroup: boolean;
	report(): SandboxReport;
	dispose(): Promise<void>;
}

function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error(`Expected a directory owned by you: ${path}`);
	}
}

function proxyRoot(): string {
	const runtime = runtimeDir();
	return runtime ? join(runtime, "pi-sandbox") : join(tmpdir(), `pi-sandbox-${process.getuid?.() ?? "user"}`);
}

async function openProxy(): Promise<{ proxy: ProxyHandle; dir: string }> {
	const root = proxyRoot();
	ensurePrivateDir(root);
	const dir = join(root, randomBytes(6).toString("hex"));
	ensurePrivateDir(dir);
	try {
		return { proxy: await startProxy(join(dir, "proxy.sock")), dir };
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

/** Create missing writable locations (as directories), so they can be bound. */
function createWritable(paths: string[]): void {
	for (const path of paths) {
		try {
			lstatSync(path);
		} catch {
			mkdirSync(path, { recursive: true });
		}
	}
}

export async function prepareSandbox(request: SandboxRequest | undefined, cwd: string): Promise<PreparedSandbox> {
	const policy = resolvePolicy(request, cwd, homedir());
	if (policy.skip) {
		return {
			policy,
			shell: (base) => base,
			env: (base) => base,
			reapGroup: false,
			report: () => ({}),
			dispose: async () => {},
		};
	}

	if (process.env[NESTED_MARKER]) {
		throw new Error(
			"Already inside a pi sandbox, which cannot nest another. This pi was likely started by a sandboxed command; start it with sandbox.dangerouslySkipSandbox so it can sandbox its own commands.",
		);
	}
	const bwrap = findExecutable("bwrap");
	if (!bwrap) throw new Error("Sandbox unavailable: bubblewrap (bwrap) is not installed.");
	if (policy.network === "fetch-only" && !findExecutable("socat")) {
		throw new Error('Sandbox networkAccess "fetch-only" needs socat, which is not installed.');
	}
	createWritable(policy.writable);

	const opened = policy.network === "fetch-only" ? await openProxy() : undefined;
	let command: SandboxCommand;
	try {
		command = buildSandboxCommand(policy, await gatherHostFacts(opened?.proxy.socketPath), cwd);
	} catch (error) {
		await opened?.proxy.close();
		if (opened) rmSync(opened.dir, { recursive: true, force: true });
		throw error;
	}

	let disposed: Promise<void> | undefined;
	return {
		policy,
		shell(base) {
			const inner =
				policy.network === "fetch-only"
					? [base.shell, "-c", PROXY_PRELUDE, "pi-sandbox", base.shell, ...base.args]
					: [base.shell, ...base.args];
			return {
				shell: bwrap,
				args: [...command.bwrapArgs, "--", ...command.entry, ...inner],
				commandTransport: base.commandTransport,
			};
		},
		env: (base) => sandboxEnv(policy, base),
		reapGroup: policy.process !== "signalling",
		report() {
			if (!opened) return {};
			return {
				network: {
					hosts: [...opened.proxy.hosts],
					denied: [...opened.proxy.denied].map(([host, reason]) => ({ host, reason })),
				},
			};
		},
		dispose() {
			disposed ??= (async () => {
				if (!opened) return;
				await opened.proxy.close();
				rmSync(opened.dir, { recursive: true, force: true });
			})();
			return disposed;
		},
	};
}

/** Exec contract of pi's BashOperations. */
export interface ExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	/** Kill the whole process group once the shell exits. */
	reapGroup?: boolean;
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * Run `command` with a prepared shell config, following pi's local exec semantics: own process
 * group, group SIGKILL on timeout/abort, "aborted" / "timeout:N" errors, 128+signal exit codes.
 * Resolves on exit and stops reading output shortly after, so a descendant holding stdout open
 * (possible only in the host PID namespace) cannot hang the call.
 */
export function execShell(shell: ShellConfig, command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> {
	const { onData, signal, timeout, env, reapGroup } = options;
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	const fromStdin = shell.commandTransport === "stdin";
	return new Promise((resolve, reject) => {
		const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
			cwd,
			env,
			detached: true,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		const kill = () => {
			if (child.pid) killGroup(child.pid);
		};
		if (timeout !== undefined && timeout > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeout * 1000);
		}
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const finish = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
		};
		child.once("error", (error) => {
			finish();
			reject(error);
		});
		let exit: { code: number | null; signalName: NodeJS.Signals | null } | undefined;
		let settled = false;
		let grace: NodeJS.Timeout | undefined;
		const settle = () => {
			if (settled || !exit) return;
			settled = true;
			if (grace) clearTimeout(grace);
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${timeout}`));
			else {
				const { code, signalName } = exit;
				resolve({ exitCode: code ?? (signalName ? 128 + (osConstants.signals[signalName] ?? 0) : 1) });
			}
		};
		child.once("exit", (code, signalName) => {
			finish();
			if (reapGroup) kill();
			exit = { code, signalName };
			grace = setTimeout(settle, 250);
		});
		// "close" follows "exit" once stdio has drained; the grace timer covers descendants holding it open.
		child.once("close", settle);
	});
}
