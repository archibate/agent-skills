import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

/** Serialize cooperating Pi saves across processes; never replace malformed config or symlink targets. */
export function savePairing(path: string, main: string, advisor: string | null): string | undefined {
	modelId(main);
	if (advisor !== null) modelId(advisor);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const target = join(realpathSync(dirname(path)), basename(path));
	const lock = `${target}.lock`;
	let lockFd: number;
	try { lockFd = openSync(lock, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Advisor pairing save is locked (${lock}). Retry when the other save finishes; a lock left by a crashed process must be removed manually.`);
		throw error;
	}
	let temporary: string | undefined;
	let committed = false;
	let failure: unknown;
	const cleanup = (operation: () => void) => { try { operation(); } catch (error) { failure ??= error; } };
	try {
		try {
			if (!lstatSync(target).isFile()) throw new Error("Advisor configuration must be a regular file, not a symlink.");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const pairings = new Map(readPolicy(undefined, target).pairings);
		pairings.set(main, advisor);
		const source = `${JSON.stringify({ pairings: Object.fromEntries(pairings) }, null, 2)}\n`;
		if (Buffer.byteLength(source) > 1024 * 1024) throw new Error("Advisor configuration exceeds 1 MiB.");
		const candidate = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
		const fd = openSync(candidate, "wx", 0o600);
		temporary = candidate;
		try { writeFileSync(fd, source); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temporary, target);
		temporary = undefined;
		committed = true;
	} catch (error) { failure = error; }
	finally {
		if (temporary) cleanup(() => unlinkSync(temporary!));
		cleanup(() => closeSync(lockFd));
		cleanup(() => unlinkSync(lock));
	}
	if (failure) {
		if (!committed) throw failure;
		return `Pairing saved, but cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`;
	}
	return undefined;
}

export function resolveAdvisor(policy: AdvisorPolicy, main: ModelIdentity | undefined): string | undefined {
	return (policy.override !== undefined ? policy.override : main && policy.pairings.get(`${main.provider}/${main.id}`)) ?? undefined;
}
