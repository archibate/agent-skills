/**
 * `--sandbox-ceiling`: the most access any tool call in this run may use, enforced deny-by-default
 * for headless runs such as subagents. A sandbox declaration (bash, job_start) must fit inside the
 * ceiling; write/edit must target a path the ceiling makes writable; only known read-only tools
 * run otherwise. Pure apart from realpath lookups.
 */

import { canonicalPath, expandPath, isWithin, resolvePolicy, type SandboxPolicy, type SandboxRequest } from "./policy.ts";

export const CEILING_FLAG = "sandbox-ceiling";

/** Tools that never write or reach beyond the host filesystem's read view. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "job_watch", "job_stop"]);
/** Tools whose `sandbox` input is the declaration to bound. */
const SANDBOXED_TOOLS = new Set(["bash", "job_start"]);
/** Tools whose `path` input is the file they write. */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

const NETWORK_RANK = { disable: 0, "fetch-only": 1, full: 2 } as const;
const PROCESS_RANK = { disable: 0, visibility: 1, signalling: 2 } as const;
const DEVICE_RANK = { none: 0, gpu: 1, full: 2 } as const;

export interface Ceiling {
	/** The flag value, quoted in block reasons. */
	source: string;
	policy: SandboxPolicy;
}

/** Parse the flag: "read-only" or a JSON sandbox object, paths resolved against `cwd`. */
export function parseCeiling(value: string, cwd: string, home: string): Ceiling {
	const text = value.trim();
	let request: unknown;
	if (text === "read-only") request = {};
	else {
		try {
			request = JSON.parse(text);
		} catch {
			throw new Error(`--${CEILING_FLAG} must be "read-only" or a JSON sandbox object, got ${JSON.stringify(value)}`);
		}
	}
	return { source: text, policy: resolvePolicy(request as SandboxRequest, cwd, home) };
}

const within = (path: string, roots: readonly string[]) => roots.some((root) => isWithin(path, root));

/** Grants `request` asks for beyond `ceiling`; empty when it fits. */
export function excessGrants(request: SandboxPolicy, ceiling: SandboxPolicy, scratchpad?: string): string[] {
	if (ceiling.skip) return [];
	if (request.skip) return ["dangerouslySkipSandbox"];
	const excess: string[] = [];
	const writableRoots = scratchpad ? [...ceiling.writable, scratchpad] : ceiling.writable;
	const writable = request.writable.filter((path) => !within(path, writableRoots));
	if (writable.length > 0) excess.push(`writableLocations ${writable.join(", ")}`);
	if (NETWORK_RANK[request.network] > NETWORK_RANK[ceiling.network]) excess.push(`networkAccess "${request.network}"`);
	const sockets = request.sockets.filter((path) => !within(path, ceiling.sockets));
	if (sockets.length > 0) excess.push(`socketAccess ${sockets.join(", ")}`);
	if (request.bus && !ceiling.bus) excess.push("sessionBusAccess");
	if (request.display && !ceiling.display) excess.push("displayAccess");
	if (PROCESS_RANK[request.process] > PROCESS_RANK[ceiling.process]) excess.push(`processAccess "${request.process}"`);
	if (DEVICE_RANK[request.device] > DEVICE_RANK[ceiling.device]) excess.push(`deviceAccess "${request.device}"`);
	return excess;
}

export interface CeilingCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	home: string;
	scratchpad?: string;
}

/** Why the call exceeds the ceiling, or undefined when it may run. */
export function ceilingViolation(ceiling: Ceiling, call: CeilingCall): string | undefined {
	const deny = (what: string) =>
		`Blocked by --${CEILING_FLAG} ${ceiling.source}: ${what}. Stay within this run's access, or report what you need instead.`;
	if (READ_ONLY_TOOLS.has(call.toolName)) return undefined;
	if (SANDBOXED_TOOLS.has(call.toolName)) {
		let request: SandboxPolicy;
		try {
			request = resolvePolicy(call.input.sandbox as SandboxRequest | undefined, call.cwd, call.home);
		} catch (error) {
			return deny(error instanceof Error ? error.message : String(error));
		}
		const excess = excessGrants(request, ceiling.policy, call.scratchpad);
		return excess.length > 0 ? deny(`${call.toolName} declares ${excess.join("; ")}`) : undefined;
	}
	if (FILE_WRITE_TOOLS.has(call.toolName)) {
		if (ceiling.policy.skip) return undefined;
		const raw = call.input.path;
		if (typeof raw !== "string" || raw === "") return deny(`${call.toolName} needs a path`);
		const path = canonicalPath(expandPath(raw.replace(/^@/, ""), call.cwd, call.home));
		const roots = call.scratchpad ? [...ceiling.policy.writable, call.scratchpad] : ceiling.policy.writable;
		// Mirrors the bash sandbox, which keeps .git/hooks and .git/config read-only.
		const gitControl = /\/\.git\/(hooks(\/|$)|config$)/.test(path);
		if (!within(path, roots) || gitControl) return deny(`${call.toolName} of ${path} is outside the writable locations`);
		return undefined;
	}
	if (ceiling.policy.skip) return undefined;
	return deny(`${call.toolName} is not a known read-only tool`);
}
