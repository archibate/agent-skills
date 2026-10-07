import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface ModelIdentity { provider: string; id: string }
export interface AdvisorPolicy {
	/** undefined follows pairings; null is an explicit process-wide disable. */
	override?: string | null;
	pairings: ReadonlyMap<string, string | null>;
}

export function modelId(value: unknown): string {
	if (typeof value !== "string" || !/^[^/\s]+\/\S+$/.test(value)) {
		throw new Error("Advisor model IDs must be exact provider/model strings (including any slashes in the model ID).");
	}
	return value;
}

export function parsePairings(source: string): ReadonlyMap<string, string | null> {
	let data: unknown;
	try { data = JSON.parse(source); } catch { throw new Error("Advisor configuration is not valid JSON."); }
	const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
	if (!object(data) || Object.keys(data).some((key) => key !== "pairings") || !object(data.pairings)) {
		throw new Error('Advisor configuration must be an object containing only "pairings", an object mapping main models to advisor models or null.');
	}
	return new Map(Object.entries(data.pairings).map(([main, advisor]) => [modelId(main), advisor === null ? null : modelId(advisor)]));
}

/** Read only user-owned configuration, bounded to 1 MiB; a missing file means no pairings. */
export function readPolicy(override: unknown, path: string): AdvisorPolicy {
	if (override !== undefined) return { override: override === "none" ? null : modelId(override), pairings: new Map() };
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pairings: new Map() };
		throw error;
	}
	try {
		const limit = 1024 * 1024;
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error("Advisor configuration must be a regular file no larger than 1 MiB.");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = readSync(fd, buffer, size, buffer.length - size, null);
			if (!read) break;
			size += read;
		}
		if (size > limit) throw new Error("Advisor configuration exceeds 1 MiB.");
		return { pairings: parsePairings(buffer.toString("utf8", 0, size)) };
	} finally { closeSync(fd); }
}

export function resolveAdvisor(policy: AdvisorPolicy, main: ModelIdentity | undefined): string | undefined {
	return (policy.override !== undefined ? policy.override : main && policy.pairings.get(`${main.provider}/${main.id}`)) ?? undefined;
}
