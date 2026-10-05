/**
 * Agent-facing sandbox declaration (shared by `bash` and `job_start`) and its resolution into a
 * concrete policy. Pure apart from realpath lookups, so it is unit-testable without bwrap.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Static, type TUnsafe, Type } from "typebox";

export const NETWORK_MODES = ["disable", "fetch-only", "full"] as const;
export const PROCESS_MODES = ["disable", "visibility", "signalling"] as const;
export const DEVICE_MODES = ["none", "gpu", "full"] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];
export type ProcessMode = (typeof PROCESS_MODES)[number];
export type DeviceMode = (typeof DEVICE_MODES)[number];

/** Plain `{type: "string", enum}`: the most portable enum shape across providers. */
function stringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

export const sandboxSchema = Type.Object(
	{
		writableLocations: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Writable directories or existing files (e.g. workspace, ~/.cache/uv). File grants allow in-place writes; creation, deletion, or replacement needs the parent directory. Missing paths are created as directories. The session scratchpad and $TMPDIR are always writable.",
			}),
		),
		networkAccess: Type.Optional(
			stringEnum(
				NETWORK_MODES,
				'Default "disable". "fetch-only": HTTP(S) through a proxy, for downloads, package installs, git over HTTPS, and read-only queries; local and private addresses stay unreachable. "full": the host network, including localhost services; for API calls that spend money or change remote state, SSH, or raw sockets.',
			),
		),
		socketAccess: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Host Unix sockets, or directories of sockets, the command may connect to (e.g. /tmp/tmux-1000/default). Connecting to host sockets is denied by default.",
			}),
		),
		sessionBusAccess: Type.Optional(
			Type.Boolean({
				description: "Expose the session and system D-Bus: systemctl, notify-send, gsettings, secret service.",
			}),
		),
		displayAccess: Type.Optional(
			Type.Boolean({
				description: "Expose the Wayland/X11 display and compositor IPC, for GUI apps and input tools.",
			}),
		),
		processAccess: Type.Optional(
			stringEnum(
				PROCESS_MODES,
				'Default "visibility": host processes are visible but cannot be signalled, and background processes end with the command. "disable": only the command\'s own processes are visible. "signalling": host processes can be signalled and background processes may outlive the command.',
			),
		),
		deviceAccess: Type.Optional(
			stringEnum(
				DEVICE_MODES,
				'Default "none" (null, zero, random, tty, shm). "gpu": adds /dev/dri and NVIDIA devices. "full": all of /dev.',
			),
		),
		dangerouslySkipSandbox: Type.Optional(
			Type.Boolean({ description: "Run without any sandbox. Only for commands that require full host access." }),
		),
	},
	{
		additionalProperties: false,
		description:
			"Access this command needs beyond the read-only default. Omit for read-only commands. Declare the narrowest access that makes the command work; the user sees the declaration.",
	},
);

export type SandboxRequest = Static<typeof sandboxSchema>;

/**
 * Compact `sandbox` parameter for tools declared next to `bash` (e.g. `job_start`), so the full
 * schema is declared once. resolvePolicy() validates the raw value at run time.
 */
export const sandboxReferenceSchema = Type.Unsafe<SandboxRequest>({
	type: "object",
	description: "Access the command needs beyond the read-only default; the same fields as bash's `sandbox`. Omit for read-only commands.",
});

const SANDBOX_FIELDS = Object.keys(sandboxSchema.properties);

export interface SandboxPolicy {
	skip: boolean;
	/** Canonical writable paths (symlinks resolved), deduplicated. */
	writable: string[];
	network: NetworkMode;
	/** Canonical socket paths or directories to expose. */
	sockets: string[];
	bus: boolean;
	display: boolean;
	process: ProcessMode;
	device: DeviceMode;
}

/** True when `path` equals `root` or lies below it. Both must be normalized absolute paths. */
export function isWithin(path: string, root: string): boolean {
	if (root === "/") return path.startsWith("/");
	return path === root || path.startsWith(root + sep);
}

export function expandPath(path: string, cwd: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return resolve(cwd, path);
}

/** realpath of the longest existing prefix, with the missing remainder appended. */
export function canonicalPath(path: string): string {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			const real = realpathSync(current);
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			missing.push(basename(current));
			current = parent;
		}
	}
}

function checkEnum<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw new Error(`sandbox.${name} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
}

function checkBoolean(name: string, value: unknown): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	throw new Error(`sandbox.${name} must be a boolean`);
}

function checkPaths(name: string, value: unknown, cwd: string, home: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`sandbox.${name} must be an array of paths`);
	const paths = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new Error(`sandbox.${name} entries must be non-empty paths`);
		}
		paths.add(canonicalPath(expandPath(entry.trim(), cwd, home)));
	}
	return [...paths];
}

export function resolvePolicy(request: SandboxRequest | undefined, cwd: string, home: string): SandboxPolicy {
	// Some models send null for omitted optional parameters.
	if (request === null) request = undefined;
	if (request !== undefined && (typeof request !== "object" || Array.isArray(request))) {
		throw new Error("sandbox must be an object");
	}
	const req = (request ?? {}) as Record<string, unknown>;
	const unknown = Object.keys(req).filter((key) => !SANDBOX_FIELDS.includes(key));
	if (unknown.length > 0) {
		throw new Error(`Unknown sandbox field ${unknown.join(", ")}; the fields are ${SANDBOX_FIELDS.join(", ")}`);
	}
	const writable = checkPaths("writableLocations", req.writableLocations, cwd, home);
	if (writable.includes("/")) {
		throw new Error(
			'sandbox.writableLocations cannot include "/". List the specific directories the command writes, or set dangerouslySkipSandbox if it needs full host access.',
		);
	}
	return {
		skip: checkBoolean("dangerouslySkipSandbox", req.dangerouslySkipSandbox),
		writable,
		network: checkEnum("networkAccess", req.networkAccess, NETWORK_MODES, "disable"),
		sockets: checkPaths("socketAccess", req.socketAccess, cwd, home),
		bus: checkBoolean("sessionBusAccess", req.sessionBusAccess),
		display: checkBoolean("displayAccess", req.displayAccess),
		process: checkEnum("processAccess", req.processAccess, PROCESS_MODES, "visibility"),
		device: checkEnum("deviceAccess", req.deviceAccess, DEVICE_MODES, "none"),
	};
}

/** True when the request asks for nothing beyond the read-only default. */
export function isReadOnlyRequest(request: SandboxRequest | undefined): boolean {
	if (!request) return true;
	return (
		!request.dangerouslySkipSandbox &&
		(request.writableLocations ?? []).length === 0 &&
		(request.networkAccess ?? "disable") === "disable" &&
		(request.socketAccess ?? []).length === 0 &&
		!request.sessionBusAccess &&
		!request.displayAccess &&
		(request.processAccess ?? "visibility") !== "signalling" &&
		(request.deviceAccess ?? "none") === "none"
	);
}

export type BadgeTone = "muted" | "accent" | "warning";

/**
 * Reviewer-facing summary of a raw (possibly partial, still-streaming) request: one part per grant,
 * each tagged with how much trust it implies. Escape-grade grants are "warning".
 */
export function describeRequest(request: unknown): Array<{ text: string; tone: BadgeTone }> {
	const req = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
	if (req.dangerouslySkipSandbox === true) return [{ text: "UNSANDBOXED", tone: "warning" }];
	const parts: Array<{ text: string; tone: BadgeTone }> = [];
	const list = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
	const writable = list(req.writableLocations);
	parts.push(writable.length ? { text: `rw ${writable.join(", ")}`, tone: "accent" } : { text: "read-only", tone: "muted" });
	if (req.networkAccess === "fetch-only") parts.push({ text: "net fetch-only", tone: "accent" });
	else if (req.networkAccess === "full") parts.push({ text: "net FULL", tone: "warning" });
	const sockets = list(req.socketAccess);
	if (sockets.length) parts.push({ text: `sockets ${sockets.join(", ")}`, tone: "warning" });
	if (req.sessionBusAccess === true) parts.push({ text: "d-bus", tone: "warning" });
	if (req.displayAccess === true) parts.push({ text: "display", tone: "warning" });
	if (req.processAccess === "disable") parts.push({ text: "proc isolated", tone: "muted" });
	else if (req.processAccess === "signalling") parts.push({ text: "proc signalling", tone: "warning" });
	if (req.deviceAccess === "gpu") parts.push({ text: "gpu", tone: "accent" });
	else if (req.deviceAccess === "full") parts.push({ text: "dev FULL", tone: "warning" });
	return parts;
}
