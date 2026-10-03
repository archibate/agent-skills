/**
 * Session-scoped analytical scratchpad. Sets TMPDIR without replacing shell tools,
 * so built-in bash, user ! commands, and the background extension inherit it.
 * Files survive shutdown/reload; this is a storage convention, not a sandbox.
 * Intended for the CLI's single active session, not concurrent SDK sessions in one process.
 */

import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUIDELINE =
	"Use this directory for temporary analytical scripts, probes, and intermediate results instead of ad-hoc /tmp paths. In bash, \"$TMPDIR\" is a shortcut for this path. Use the absolute path with read/write/edit, which do not expand environment variables. Keep project changes and final deliverables in their intended locations.";

function checkDirectory(path: string, privateAccess: boolean): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Expected a directory, not a file or symlink: ${path}`);
	}
	if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & (privateAccess ? 0o077 : 0o022)) !== 0)) {
		throw new Error(`Scratchpad directory must be owned by you with ${privateAccess ? "0700" : "no group/other write"} permissions: ${path}`);
	}
	accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

function makeDirectory(path: string, privateAccess: boolean): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	checkDirectory(path, privateAccess);
}

function prepareScratchpad(sessionId: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
		throw new Error("Invalid scratchpad session ID");
	}
	const configured = process.env.XDG_CACHE_HOME;
	const cacheHome = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
	mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
	// A cache-home symlink is legitimate; validate its target before creating app directories.
	const cache = realpathSync(cacheHome);
	checkDirectory(cache, false);
	const app = join(cache, "pi");
	const root = join(app, "scratchpad");
	const path = join(root, sessionId);
	makeDirectory(app, false);
	makeDirectory(root, true);
	makeDirectory(path, true);
	return path;
}

export default function scratchpadExtension(pi: ExtensionAPI): void {
	let active: { path: string; previousTmpdir: string | undefined } | undefined;
	let failure: string | undefined = "Scratchpad session has not started";

	function release(): void {
		if (active && process.env.TMPDIR === active.path) {
			if (active.previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = active.previousTmpdir;
		}
		active = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		release();
		try {
			const path = prepareScratchpad(ctx.sessionManager.getSessionId());
			active = { path, previousTmpdir: process.env.TMPDIR };
			process.env.TMPDIR = path;
			failure = undefined;
		} catch (error) {
			failure = `Scratchpad initialization failed: ${error instanceof Error ? error.message : String(error)}. Fix the directory/configuration and run /reload.`;
			throw new Error(failure, { cause: error });
		}
	});

	pi.on("before_agent_start", (event) => {
		const guideline = failure
			? "The session scratchpad is unavailable. Fix the reported initialization error and run /reload before running analytical commands."
			: `Session scratchpad: ${JSON.stringify(active!.path)}. ${GUIDELINE}`;
		const guidelines = event.systemPromptOptions.promptGuidelines;
		if (!guidelines.includes(guideline)) guidelines.push(guideline);
	});

	// Pi reports session_start errors but continues. Don't silently execute shells with an old TMPDIR.
	pi.on("tool_call", (event) => {
		if (failure && ["bash", "powershell", "monitor"].includes(event.toolName)) {
			return { block: true, reason: failure };
		}
	});

	pi.on("user_bash", () => {
		if (failure) throw new Error(failure);
		// Successful setup passes through to other extensions and Pi's default executor.
	});

	pi.on("session_shutdown", () => {
		release();
		failure = "Scratchpad session has ended";
	});

	pi.registerCommand("scratchpad", {
		description: "Show the session scratchpad (TMPDIR)",
		handler: async (_args, ctx) => {
			const text = failure ?? `TMPDIR=${active!.path}`;
			if (ctx.hasUI) ctx.ui.notify(text, failure ? "error" : "info");
			else console.log(text);
		},
	});
}
