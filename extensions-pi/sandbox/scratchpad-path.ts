import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Prefer an allocated session workspace, even without the scratchpad environment extension. */
export function sessionScratchpad(sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!sessionId) return env.PI_SCRATCHPAD_DIR;
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) throw new Error("Invalid scratchpad session ID");
	const cache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
	let root: string;
	try { root = realpathSync(cache); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return env.PI_SCRATCHPAD_DIR;
		throw error;
	}
	const path = join(root, "pi", "scratchpad", sessionId);
	let stat;
	try { stat = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return env.PI_SCRATCHPAD_DIR;
		throw error;
	}
	if (!stat.isDirectory() || realpathSync(path) !== path ||
		(process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
		throw new Error(`Unsafe session scratchpad: ${path}`);
	}
	return path;
}
