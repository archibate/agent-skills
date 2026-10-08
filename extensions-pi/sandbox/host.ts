/**
 * Host facts the sandbox needs at spawn time: executables, the landlock-exec helper, and
 * display/bus/GPU endpoints.
 *
 * landlock-exec is compiled from landlock-exec.c on first use into
 * ${XDG_CACHE_HOME:-~/.cache}/pi/sandbox/<source-hash>/, so a changed source rebuilds itself.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostFacts } from "./bwrap.ts";

const HELPER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "landlock-exec.c");

export function findExecutable(name: string): string | undefined {
	for (const dir of [...(process.env.PATH ?? "").split(":"), "/usr/bin", "/usr/local/bin", "/bin"]) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function runtimeDir(): string | undefined {
	const value = process.env.XDG_RUNTIME_DIR;
	return value && isAbsolute(value) ? value : undefined;
}

function cacheHome(): string {
	const configured = process.env.XDG_CACHE_HOME;
	return configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
}

interface HelperState {
	built: Map<string, Promise<string>>;
}

const helperState: HelperState = ((globalThis as { __piSandboxHelper?: HelperState }).__piSandboxHelper ??= {
	built: new Map(),
});

function compile(source: string, output: string): Promise<void> {
	const cc = findExecutable("cc") ?? findExecutable("gcc") ?? findExecutable("clang");
	if (!cc) return Promise.reject(new Error("Sandbox unavailable: no C compiler (cc) to build landlock-exec."));
	return new Promise((resolve, reject) => {
		execFile(cc, ["-O2", "-Wall", "-o", output, source], { timeout: 60_000 }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`Sandbox unavailable: building landlock-exec failed: ${String(stderr).trim() || error.message}`));
			else resolve();
		});
	});
}

/** Path of the built landlock-exec helper, compiling it once per source revision. */
export function landlockExec(): Promise<string> {
	const hash = createHash("sha256").update(readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 16);
	let built = helperState.built.get(hash);
	if (!built) {
		const dir = join(cacheHome(), "pi", "sandbox", hash);
		const binary = join(dir, "landlock-exec");
		built = (async () => {
			if (existsSync(binary)) return binary;
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// Build under a unique name and rename, so concurrent pi processes never see a partial file.
			const partial = `${binary}.${process.pid}.tmp`;
			try {
				await compile(HELPER_SOURCE, partial);
				renameSync(partial, binary);
			} finally {
				rmSync(partial, { force: true });
			}
			return binary;
		})();
		built.catch(() => helperState.built.delete(hash));
		helperState.built.set(hash, built);
	}
	return built;
}

function listMatching(dir: string, pattern: RegExp): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => pattern.test(name))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

function displaySockets(runtime: string | undefined): string[] {
	const sockets = ["/tmp/.X11-unix"];
	if (runtime) sockets.push(...listMatching(runtime, /^(wayland-\d+|xwls-\d+)$/));
	const niri = process.env.NIRI_SOCKET;
	if (niri && isAbsolute(niri)) sockets.push(niri);
	return sockets;
}

/** Missing children (including children of a regular file) need no protection mount. */
export function gitControlPaths(writable: readonly string[]): string[] {
	const paths: string[] = [];
	for (const root of writable) {
		for (const path of [join(root, ".git", "hooks"), join(root, ".git", "config")]) {
			try {
				statSync(path);
				paths.push(path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			}
		}
	}
	return paths;
}

export async function gatherHostFacts(writable: readonly string[], proxySocket?: string, scratchpad = process.env.PI_SCRATCHPAD_DIR): Promise<HostFacts> {
	const runtime = runtimeDir();
	return {
		landlockExec: await landlockExec(),
		gitControlPaths: gitControlPaths(writable),
		scratchpad: scratchpad && isAbsolute(scratchpad) && existsSync(scratchpad) ? scratchpad : undefined,
		resolverDir: existsSync("/run/systemd/resolve") ? "/run/systemd/resolve" : undefined,
		busSockets: [...(runtime ? [join(runtime, "bus")] : []), "/run/dbus/system_bus_socket"],
		displaySockets: displaySockets(runtime),
		gpuDevices: ["/dev/dri", ...listMatching("/dev", /^nvidia/)],
		proxySocket,
	};
}
