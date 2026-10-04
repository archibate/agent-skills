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
