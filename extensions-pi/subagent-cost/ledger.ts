import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface CostRecord {
	version: 1;
	parentSessionFile: string;
	childSessionFile: string;
	childSessionId: string;
	costUSD: number;
}
export interface Summary { costUSD: number; count: number }
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
// Two filesystem paths plus an ID; reject oversized/untrusted records before parsing.
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_PENDING = 1024;

export function sessionPath(path: string): string {
	if (!isAbsolute(path)) throw new Error("Expected an absolute session path");
	const absolute = resolve(path);
	try { return realpathSync(absolute); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	// New Pi sessions have a path before the first conversation writes the file.
	return join(realpathSync(dirname(absolute)), basename(absolute));
}

function checkDirectory(path: string, privateAccess: boolean) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid &&
		(stat.uid !== process.getuid() || (stat.mode & (privateAccess ? 0o077 : 0o022)) !== 0))) {
		throw new Error(`Unsafe accounting directory: ${path}`);
	}
	return stat;
}

export function ledgerDirectory(parentSessionFile: string): string {
	return `${parentSessionFile}.subagent-cost`;
}

export function prepareDirectory(parentSessionFile: string): string {
	checkDirectory(dirname(parentSessionFile), false);
	const directory = ledgerDirectory(parentSessionFile);
	try { mkdirSync(directory, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	checkDirectory(directory, true);
	return directory;
}

export function recordName(childSessionFile: string): string {
	return `${createHash("sha256").update(childSessionFile).digest("hex")}.json`;
}

function validRecord(value: unknown, parent: string, filename: string): value is CostRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as CostRecord;
	return r.version === 1 && r.parentSessionFile === parent &&
		typeof r.childSessionFile === "string" && isAbsolute(r.childSessionFile) &&
		r.childSessionFile !== parent && recordName(r.childSessionFile) === filename &&
		typeof r.childSessionId === "string" && r.childSessionId.length > 0 &&
		typeof r.costUSD === "number" && Number.isFinite(r.costUSD) && r.costUSD >= 0;
}

/** One writer per child session, matching Pi's own session-file ownership model. */
export function publish(record: CostRecord): void {
	const filename = recordName(record.childSessionFile);
	if (!validRecord(record, record.parentSessionFile, filename)) throw new Error("Invalid cost record");
	const data = JSON.stringify(record) + "\n";
	if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error("Cost record too large");
	const directory = prepareDirectory(record.parentSessionFile);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
		renameSync(temporary, join(directory, filename));
	} finally {
		try { unlinkSync(temporary); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

/** Watches only this parent's tiny snapshots, never the session directory/transcripts. */
export class CostLedger {
	private watcher?: FSWatcher;
	private directoryIdentity?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private pending = new Set<string>();
	private fullScan = false;
	private closed = false;
	private records = new Map<string, number>();
	private total = 0;
	readonly directory: string;
	readonly parent: string;
	private readonly changed: () => void;
	private readonly failed: (error: unknown) => void;

	constructor(parent: string, changed: () => void, failed: (error: unknown) => void) {
		this.parent = parent;
		this.changed = changed;
		this.failed = failed;
		this.directory = prepareDirectory(parent);
		this.reconcile();
	}

	summary(): Summary { return { costUSD: this.total, count: this.records.size }; }

	private report(error: unknown): void {
		try { this.failed(error); } catch { /* Diagnostics must not crash the host. */ }
	}

	private stopWatching(): void {
		const watcher = this.watcher;
		this.watcher = undefined;
		this.directoryIdentity = undefined;
		try { watcher?.close(); } catch (error) { this.report(error); }
	}

	private startWatching(): void {
		if (this.closed) return;
		try {
			const stat = checkDirectory(this.directory, true);
			const identity = `${stat.dev}:${stat.ino}`;
			if (this.watcher && this.directoryIdentity === identity) return;
			this.stopWatching();
			const watcher = watch(this.directory, { persistent: false }, (_event, filename) => {
				try {
					const name = filename?.toString();
					this.schedule(name === basename(this.directory) ? undefined : name);
				} catch (error) { this.report(error); }
			});
			this.watcher = watcher;
			this.directoryIdentity = identity;
			watcher.on("error", (error) => {
				if (this.watcher === watcher) this.stopWatching();
				this.report(error);
			});
		} catch (error) { this.stopWatching(); this.report(error); }
	}

	private schedule(filename?: string): void {
		if (this.closed) return;
		if (!filename) this.fullScan = true;
		else if (RECORD_NAME.test(filename)) {
			if (this.pending.size >= MAX_PENDING) this.fullScan = true;
			else this.pending.add(filename);
		} else return; // Atomic-write temporary files are not publications.
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.fullScan) this.reconcile();
			else {
				const before = this.summary();
				for (const name of this.pending) this.read(name);
				this.pending.clear();
				this.notifyChange(before);
			}
		}, 50);
		this.timer.unref();
	}

	private read(filename: string): void {
		let fd: number | undefined;
		try {
			fd = openSync(join(this.directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || (process.getuid &&
				(stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error(`Unsafe cost record: ${filename}`);
			const record: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (!validRecord(record, this.parent, filename)) throw new Error(`Invalid cost record: ${filename}`);
			const previous = this.records.get(filename) ?? 0;
			// Cumulative spend cannot decrease; duplicate/coalesced notifications are harmless.
			const cost = Math.max(previous, record.costUSD);
			const total = this.total + (cost - previous);
			if (!Number.isFinite(total)) throw new Error("Cost total overflow");
			this.records.set(filename, cost);
			this.total = total;
		} catch (error) {
			// Keep the last valid snapshot on corruption/deletion, rather than silently losing spend.
			this.report(error);
		} finally {
			try { if (fd !== undefined) closeSync(fd); } catch (error) { this.report(error); }
		}
	}

	private notifyChange(before: Summary): void {
		if (before.costUSD !== this.total || before.count !== this.records.size) {
			try { this.changed(); } catch (error) { this.report(error); }
		}
	}

	/** Startup, /session and next user turn repair missed notifications; never a periodic timer. */
	reconcile(): void {
		if (this.closed) return;
		this.startWatching(); // Subscribe before reading to close the initial scan/watch race.
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.fullScan = false;
		const before = this.summary();
		try {
			checkDirectory(this.directory, true);
			for (const name of readdirSync(this.directory)) if (RECORD_NAME.test(name)) this.read(name);
		} catch (error) { this.report(error); }
		this.notifyChange(before);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopWatching();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}
}
