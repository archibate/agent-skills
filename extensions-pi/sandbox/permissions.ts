/**
 * Permissions: the access that runs without review (the allowance), and the check that names what
 * a tool call needs beyond it. The reviewer (review.ts) decides those calls. Pure apart from
 * realpath and git-root lookups.
 *
 * Pre-approval only skips review; it adds no access. A sandboxed call still gets exactly what it
 * declares, so a bash call that declares nothing runs read-only whatever the allowance is.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	canonicalPath,
	DEVICE_MODES,
	expandPath,
	isWithin,
	NETWORK_MODES,
	PROCESS_MODES,
	resolvePolicy,
	type SandboxPolicy,
	type SandboxRequest,
} from "./policy.ts";
import { parseSubagentLaunch } from "./subagent.ts";

export const PERMISSIONS_FLAG = "permissions";
export const PERMISSION_PRESETS = ["default", "read-only"] as const;

export interface Allowance {
	/** Sandbox grants that need no review. `skip` turns review off entirely. */
	policy: SandboxPolicy;
	/** Tools outside the sandbox model that need no review. */
	tools: "all" | string[];
}

/** Reads and session-control tools without unrestricted filesystem or network access. */
const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ls", "job_watch", "job_stop",
	"enter_plan_mode", "ask_question", "exit_plan_mode",
]);
/** Tools whose `sandbox` input is the declaration to check. */
const SANDBOXED_TOOLS = new Set(["bash", "job_start"]);
/** Tools whose `path` input is the file they write. */
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);

const rank = <T extends string>(modes: readonly T[], mode: T) => modes.indexOf(mode);
const maxMode = <T extends string>(modes: readonly T[], a: T, b: T) => (rank(modes, a) >= rank(modes, b) ? a : b);
const within = (path: string, roots: readonly string[]) => roots.some((root) => isWithin(path, root));
const unique = (paths: readonly string[]) => [...new Set(paths)];

/** No grants at all; the identity for `unionAllowance`. */
export const NO_ACCESS: Allowance = {
	policy: {
		skip: false,
		writable: [],
		network: "disable",
		sockets: [],
		bus: false,
		display: false,
		process: "disable",
		device: "none",
	},
	tools: [],
};

/** Whether `dir` holds a git repository marker that git itself would accept. */
function isWorkTree(dir: string): boolean {
	const marker = join(dir, ".git");
	try {
		if (statSync(marker).isDirectory()) return existsSync(join(marker, "HEAD"));
		return readFileSync(marker, "utf8").startsWith("gitdir:");
	} catch {
		return false;
	}
}

/**
 * The git work tree containing `cwd`, if any. Home and / never count: a dotfiles repository there
 * would make every write under it pre-approved.
 */
export function workspaceRoot(cwd: string, home: string): string | undefined {
	const excluded = new Set(["/", canonicalPath(home)]);
	for (let dir = canonicalPath(cwd); ; dir = dirname(dir)) {
		if (isWorkTree(dir)) return excluded.has(dir) ? undefined : dir;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * `default`: the git work tree is writable, fetch-only network, other tools allowed.
 * `read-only`: nothing beyond the read-only sandbox; other tools need review.
 */
export function presetAllowance(name: (typeof PERMISSION_PRESETS)[number], cwd: string, home: string): Allowance {
	if (name === "read-only") return { policy: resolvePolicy({}, cwd, home), tools: [] };
	const root = workspaceRoot(cwd, home);
	return {
		policy: resolvePolicy({ writableLocations: root ? [root] : [], networkAccess: "fetch-only" }, cwd, home),
		tools: "all",
	};
}

/**
 * Parse a --permissions value: a preset name, or a JSON sandbox object plus an optional `tools`
 * list, with paths resolved against `cwd`.
 */
export function parsePermissions(value: string, cwd: string, home: string): Allowance {
	const text = value.trim();
	if ((PERMISSION_PRESETS as readonly string[]).includes(text)) {
		return presetAllowance(text as (typeof PERMISSION_PRESETS)[number], cwd, home);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(
			`--${PERMISSIONS_FLAG} must be ${PERMISSION_PRESETS.map((p) => `"${p}"`).join(" or ")}, or a JSON sandbox object; got ${JSON.stringify(value)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`--${PERMISSIONS_FLAG} JSON must be an object`);
	}
	const { tools, ...request } = parsed as Record<string, unknown>;
	if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))) {
		throw new Error(`--${PERMISSIONS_FLAG} "tools" must be an array of tool names`);
	}
	return { policy: resolvePolicy(request as SandboxRequest, cwd, home), tools: (tools as string[] | undefined) ?? [] };
}

/** Every grant of either allowance. */
export function unionAllowance(a: Allowance, b: Allowance): Allowance {
	const p = a.policy;
	const q = b.policy;
	return {
		policy: {
			skip: p.skip || q.skip,
			writable: unique([...p.writable, ...q.writable]),
			network: maxMode(NETWORK_MODES, p.network, q.network),
			sockets: unique([...p.sockets, ...q.sockets]),
			bus: p.bus || q.bus,
			display: p.display || q.display,
			process: maxMode(PROCESS_MODES, p.process, q.process),
			device: maxMode(DEVICE_MODES, p.device, q.device),
		},
		tools: a.tools === "all" || b.tools === "all" ? "all" : unique([...a.tools, ...b.tools]),
	};
}

/** Only grants shared by both allowances. A skipped sandbox is the unrestricted identity. */
export function intersectAllowance(a: Allowance, b: Allowance): Allowance {
	if (a.policy.skip) return b;
	if (b.policy.skip) return a;
	const p = a.policy, q = b.policy;
	const minMode = <T extends string>(modes: readonly T[], x: T, y: T): T => rank(modes, x) <= rank(modes, y) ? x : y;
	const sharedPaths = (xs: string[], ys: string[]): string[] => unique(xs.flatMap((x) =>
		ys.flatMap((y) => isWithin(x, y) ? [x] : isWithin(y, x) ? [y] : [])));
	return {
		policy: {
			skip: false,
			writable: sharedPaths(p.writable, q.writable),
			network: minMode(NETWORK_MODES, p.network, q.network),
			sockets: sharedPaths(p.sockets, q.sockets),
			bus: p.bus && q.bus,
			display: p.display && q.display,
			process: minMode(PROCESS_MODES, p.process, q.process),
			device: minMode(DEVICE_MODES, p.device, q.device),
		},
		tools: a.tools === "all" ? b.tools : b.tools === "all" ? a.tools : a.tools.filter((tool) => b.tools.includes(tool)),
	};
}

/** Validate an allowance read back from a session entry. */
export function isAllowance(data: unknown): data is Allowance {
	if (typeof data !== "object" || data === null) return false;
	const { policy, tools } = data as Partial<Allowance>;
	const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string");
	return (
		typeof policy === "object" &&
		policy !== null &&
		typeof policy.skip === "boolean" &&
		strings(policy.writable) &&
		(NETWORK_MODES as readonly string[]).includes(policy.network) &&
		strings(policy.sockets) &&
		typeof policy.bus === "boolean" &&
		typeof policy.display === "boolean" &&
		(PROCESS_MODES as readonly string[]).includes(policy.process) &&
		(DEVICE_MODES as readonly string[]).includes(policy.device) &&
		(tools === "all" || strings(tools))
	);
}

/** Grants `request` asks for beyond `allowance`; empty when it fits. */
export function excessGrants(request: SandboxPolicy, allowance: SandboxPolicy, scratchpad?: string): string[] {
	if (allowance.skip) return [];
	if (request.skip) return ["dangerouslySkipSandbox"];
	const excess: string[] = [];
	const writableRoots = scratchpad ? [...allowance.writable, scratchpad] : allowance.writable;
	const writable = request.writable.filter((path) => !within(path, writableRoots));
	if (writable.length > 0) excess.push(`writableLocations ${writable.join(", ")}`);
	if (rank(NETWORK_MODES, request.network) > rank(NETWORK_MODES, allowance.network)) {
		excess.push(`networkAccess "${request.network}"`);
	}
	const sockets = request.sockets.filter((path) => !within(path, allowance.sockets));
	if (sockets.length > 0) excess.push(`socketAccess ${sockets.join(", ")}`);
	if (request.bus && !allowance.bus) excess.push("sessionBusAccess");
	if (request.display && !allowance.display) excess.push("displayAccess");
	if (rank(PROCESS_MODES, request.process) > rank(PROCESS_MODES, allowance.process)) {
		excess.push(`processAccess "${request.process}"`);
	}
	if (rank(DEVICE_MODES, request.device) > rank(DEVICE_MODES, allowance.device)) {
		excess.push(`deviceAccess "${request.device}"`);
	}
	return excess;
}

export interface ToolCall {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	home: string;
	scratchpad?: string;
}

export type Assessment =
	| { kind: "allow" }
	/** The call is malformed; review cannot make it valid. */
	| { kind: "invalid"; message: string }
	| {
			kind: "review";
			/** What is being asked for, e.g. "bash" or "subagent launch with --permissions read-only". */
			subject: string;
			/** Reviewer-facing grants beyond the allowance. */
			excess: string[];
			/** What "always" adds to the allowance; absent when it cannot be pre-approved. */
			always?: Allowance;
	  };

function sandboxedAssessment(allowance: Allowance, call: ToolCall): Assessment {
	let request: SandboxPolicy;
	try {
		request = resolvePolicy(call.input.sandbox as SandboxRequest | undefined, call.cwd, call.home);
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
	// A pi subagent bounded by --permissions gets that access; pi itself needs the host.
	if (request.skip && call.toolName === "job_start" && typeof call.input.command === "string") {
		const launch = parseSubagentLaunch(call.input.command, call.cwd, call.home);
		if (launch) {
			let child: Allowance;
			try {
				child = parsePermissions(launch.permissions, launch.cwd, call.home);
			} catch (error) {
				return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
			}
			const excess = excessGrants(child.policy, allowance.policy, call.scratchpad);
			const tools = toolExcess(child.tools, allowance.tools);
			if (tools) excess.push(tools);
			if (excess.length === 0) return { kind: "allow" };
			return {
				kind: "review",
				subject: `subagent launch with --${PERMISSIONS_FLAG} ${launch.permissions}`,
				excess,
				always: child,
			};
		}
	}
	const excess = excessGrants(request, allowance.policy, call.scratchpad);
	if (excess.length === 0) return { kind: "allow" };
	return { kind: "review", subject: call.toolName, excess, always: { policy: request, tools: [] } };
}

function toolExcess(wanted: Allowance["tools"], allowed: Allowance["tools"]): string | undefined {
	if (allowed === "all") return undefined;
	if (wanted === "all") return "every other tool";
	const missing = wanted.filter((tool) => !allowed.includes(tool));
	return missing.length > 0 ? `tools ${missing.join(", ")}` : undefined;
}

/** Decide whether `call` fits `allowance`, and what review would have to approve if not. */
export function assessCall(allowance: Allowance, call: ToolCall): Assessment {
	if (READ_ONLY_TOOLS.has(call.toolName) || allowance.policy.skip) return { kind: "allow" };
	if (SANDBOXED_TOOLS.has(call.toolName)) return sandboxedAssessment(allowance, call);
	if (FILE_WRITE_TOOLS.has(call.toolName)) {
		const raw = call.input.path;
		if (typeof raw !== "string" || raw === "") return { kind: "invalid", message: `${call.toolName} needs a path` };
		const path = canonicalPath(expandPath(raw.replace(/^@/, ""), call.cwd, call.home));
		// The bash sandbox keeps .git/hooks and .git/config read-only; so does pre-approval here.
		if (/\/\.git\/(hooks(\/|$)|config$)/.test(path)) {
			return { kind: "review", subject: call.toolName, excess: [`git control file ${path}`] };
		}
		const roots = call.scratchpad ? [...allowance.policy.writable, call.scratchpad] : allowance.policy.writable;
		if (within(path, roots)) return { kind: "allow" };
		return {
			kind: "review",
			subject: call.toolName,
			excess: [`write to ${path}`],
			always: { policy: { ...NO_ACCESS.policy, writable: [dirname(path)] }, tools: [] },
		};
	}
	const tools = toolExcess([call.toolName], allowance.tools);
	if (!tools) return { kind: "allow" };
	return {
		kind: "review",
		subject: call.toolName,
		excess: [`tool ${call.toolName}`],
		always: { ...NO_ACCESS, tools: [call.toolName] },
	};
}

/** One-line summary of an allowance, for titles and denial reasons. */
export function describeAllowance(allowance: Allowance): string {
	const p = allowance.policy;
	if (p.skip) return "everything (review off)";
	const parts = [p.writable.length > 0 ? `write ${p.writable.join(", ")}` : "read-only"];
	if (p.network !== "disable") parts.push(`net ${p.network}`);
	if (p.sockets.length > 0) parts.push(`sockets ${p.sockets.join(", ")}`);
	if (p.bus) parts.push("bus");
	if (p.display) parts.push("display");
	if (p.process !== "visibility") parts.push(`proc ${p.process}`);
	if (p.device !== "none") parts.push(`dev ${p.device}`);
	if (allowance.tools === "all") parts.push("other tools");
	else if (allowance.tools.length > 0) parts.push(`tools ${allowance.tools.join(", ")}`);
	return parts.join(" · ");
}
