/**
 * Snapshot storage and restore planning for the rewind extension.
 *
 * Checkpoints hold content-addressed pre-images of files pi was about to
 * change. Restoring a prompt replays those pre-images, so code rewind is exact
 * for files pi edited and leaves everything else untouched.
 *
 * Pure filesystem logic lives here, separate from the pi event wiring in
 * index.ts, so it can be unit tested without the Pi runtime.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SnapshotFile {
	/** Path relative to the session working directory. */
	path: string;
	/** Blob hash, or "" when the file did not exist before the tool call. */
	hash: string;
	/** False when the captured tool call created the file. */
	existed: boolean;
}

export interface Checkpoint {
	/** Session entry id of the user message that started the prompt. */
	entryId: string;
	/** Monotonic per-session ordering, used for chronological restore. */
	seq: number;
	timestamp: number;
	files: SnapshotFile[];
}

export function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Absolute or cwd-relative input path -> path relative to cwd, or undefined when outside cwd. */
export function toWorkspaceRelative(cwd: string, inputPath: string): string | undefined {
	const root = resolve(cwd);
	const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
	if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
	return relative(root, absolute);
}

/** Symlinks and hard links are skipped because rewriting them replaces the link, not the file. */
export function isRestorableFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= 1;
	} catch {
		return false;
	}
}

export class BlobStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private blobPath(hash: string): string {
		return join(this.root, "blobs", hash);
	}

	/** Store `data` and return its content hash, writing the blob only when it is new. */
	put(data: Buffer): string {
		const hash = sha256(data);
		const path = this.blobPath(hash);
		if (existsSync(path)) return hash;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, data, { mode: 0o600 });
		renameSync(temp, path);
		return hash;
	}

	get(hash: string): Buffer | undefined {
		try {
			return readFileSync(this.blobPath(hash));
		} catch {
			return undefined;
		}
	}

	hashes(): string[] {
		try {
			return readdirSync(join(this.root, "blobs"));
		} catch {
			return [];
		}
	}

	/** Delete every blob not in `referenced`. Returns the number of blobs removed. */
	gc(referenced: Set<string>): number {
		let removed = 0;
		for (const hash of this.hashes()) {
			if (referenced.has(hash)) continue;
			try {
				rmSync(this.blobPath(hash));
				removed++;
			} catch {
				// Best effort. A leftover temp file or a concurrent session is not fatal.
			}
		}
		return removed;
	}
}

/**
 * The state to restore when rewinding to `target`.
 *
 * Every file touched by the target prompt or a later one is rolled back to the
 * pre-image of its earliest such call. Files never touched after the target are
 * left alone, because their current content already matches the target state.
 */
export function planRestore(checkpoints: Checkpoint[], target: Checkpoint): Map<string, SnapshotFile> {
	const plan = new Map<string, SnapshotFile>();
	const affected = checkpoints
		.filter((checkpoint) => checkpoint.seq >= target.seq)
		.sort((a, b) => a.seq - b.seq);
	for (const checkpoint of affected) {
		for (const file of checkpoint.files) {
			if (!plan.has(file.path)) plan.set(file.path, file);
		}
	}
	return plan;
}

export interface RestoreReport {
	restored: string[];
	deleted: string[];
	skipped: string[];
	missing: string[];
}
export function applyRestore(cwd: string, plan: Map<string, SnapshotFile>, blobs: BlobStore): RestoreReport {
	const report: RestoreReport = { restored: [], deleted: [], skipped: [], missing: [] };
	const root = resolve(cwd);
	for (const [relPath, file] of plan) {
		const absolute = resolve(root, relPath);
		if (absolute !== root && !absolute.startsWith(root + sep)) {
			report.skipped.push(relPath);
			continue;
		}
		if (file.existed) {
			const data = blobs.get(file.hash);
			if (data === undefined) {
				report.missing.push(relPath);
				continue;
			}
			try {
				const stat = lstatSync(absolute);
				if (stat.isSymbolicLink() || stat.nlink > 1) {
					report.skipped.push(relPath);
					continue;
				}
			} catch {
				// Absent right now: recreate it.
			}
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, data);
			report.restored.push(relPath);
		} else {
			let stat;
			try {
				stat = lstatSync(absolute);
			} catch {
				continue; // Already absent, nothing to do.
			}
			if (stat.isSymbolicLink() || stat.nlink > 1 || stat.isDirectory()) {
				report.skipped.push(relPath);
				continue;
			}
			rmSync(absolute);
			report.deleted.push(relPath);
		}
	}
	return report;
}

export interface FileChangeStat {
	path: string;
	added: number;
	removed: number;
}

export interface CheckpointStat {
	totalAdded: number;
	totalRemoved: number;
	files: FileChangeStat[];
}

/** Large enough for ordinary source files, small enough to stay instant in the picker. */
const MAX_DIFF_CELLS = 16_000_000;

/** Git-like line splitting: a trailing newline does not create a final empty line. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	return trimmed.split("\n");
}

function lcsMatrix(a: string[], b: string[]): number {
	const m = a.length;
	const n = b.length;
	let previous = new Uint32Array(n + 1);
	let current = new Uint32Array(n + 1);
	for (let i = 1; i <= m; i++) {
		const line = a[i - 1];
		for (let j = 1; j <= n; j++) {
			current[j] = line === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
		}
		[previous, current] = [current, previous];
	}
	return previous[n]!;
}

/** Fallback for very large rewrites: multiset intersection upper-bounds the LCS. */
function commonLineCount(a: string[], b: string[]): number {
	const counts = new Map<string, number>();
	for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of b) {
		const left = counts.get(line) ?? 0;
		if (left > 0) {
			counts.set(line, left - 1);
			common++;
		}
	}
	return common;
}

function lcsLength(a: string[], b: string[]): number {
	let prefix = 0;
	const limit = Math.min(a.length, b.length);
	while (prefix < limit && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const middleA = a.slice(prefix, a.length - suffix);
	const middleB = b.slice(prefix, b.length - suffix);
	if (middleA.length === 0 || middleB.length === 0) return prefix + suffix;
	const common =
		middleA.length * middleB.length > MAX_DIFF_CELLS
			? commonLineCount(middleA, middleB)
			: lcsMatrix(middleA, middleB);
	return prefix + suffix + common;
}

/**
 * Added/removed line counts between two file contents.
 *
 * An absent file is passed as the empty string, so creating a file reports its
 * lines as added and deleting one reports its lines as removed.
 */
export function countChangedLines(before: string, after: string): { added: number; removed: number } {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const common = lcsLength(beforeLines, afterLines);
	return { added: afterLines.length - common, removed: beforeLines.length - common };
}

/**
 * Line-level change counts for every checkpoint, used by the rewind picker.
 *
 * A checkpoint stores only pre-images. A file's post-image is the pre-image of
 * the next checkpoint that touched it, or its current content on disk when no
 * later checkpoint did. Diffing the two yields the lines that prompt added and
 * removed.
 */
export function summarizeCheckpoints(
	cwd: string,
	checkpoints: Checkpoint[],
	blobs: BlobStore,
): Map<Checkpoint, CheckpointStat> {
	const root = resolve(cwd);
	const next = new Map<string, SnapshotFile>();
	const blobCache = new Map<string, string | undefined>();
	const diskCache = new Map<string, string | undefined>();
	const result = new Map<Checkpoint, CheckpointStat>();

	const blobText = (hash: string): string | undefined => {
		if (!blobCache.has(hash)) blobCache.set(hash, blobs.get(hash)?.toString("utf8"));
		return blobCache.get(hash);
	};
	const diskText = (relPath: string): string | undefined => {
		if (diskCache.has(relPath)) return diskCache.get(relPath);
		const absolute = resolve(root, relPath);
		let text: string | undefined;
		if (absolute === root || absolute.startsWith(root + sep)) {
			try {
				text = readFileSync(absolute, "utf8");
			} catch {
				text = undefined;
			}
		}
		diskCache.set(relPath, text);
		return text;
	};

	const ordered = [...checkpoints].sort((a, b) => a.seq - b.seq);
	for (let i = ordered.length - 1; i >= 0; i--) {
		const checkpoint = ordered[i]!;
		const files: FileChangeStat[] = [];
		let totalAdded = 0;
		let totalRemoved = 0;
		for (const file of checkpoint.files) {
			const before = file.existed ? blobText(file.hash) : undefined;
			const afterCapture = next.get(file.path);
			const after = afterCapture
				? afterCapture.existed
					? blobText(afterCapture.hash)
					: undefined
				: diskText(file.path);
			const { added, removed } = countChangedLines(before ?? "", after ?? "");
			files.push({ path: file.path, added, removed });
			totalAdded += added;
			totalRemoved += removed;
			next.set(file.path, file);
		}
		result.set(checkpoint, { totalAdded, totalRemoved, files });
	}
	return result;
}
