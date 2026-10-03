/**
 * Job engine for the jobs extension: one background command per job, in its own process group,
 * with output under $TMPDIR/pi-jobs/<id>/. Process-wide state lives on globalThis so it
 * survives /reload. On pi exit, live jobs are killed and the files this process created are removed.
 *
 * Dependency-free on purpose: the shell config is injected (or resolved lazily from pi), so the
 * engine can be unit-tested with `node --test` without resolving the pi package.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_RETAINED_JOBS = 64;
const LINGER_PRUNE_MS = 10_000;

/** Resolved per call, so job logs follow the current TMPDIR (for example after the scratchpad extension sets it). */
export function rootDir(): string {
	return join(tmpdir(), "pi-jobs");
}

/**
 * Ensure the shared `pi-jobs` root: a real directory (not a symlink) that is sticky and
 * world-writable (1777), like /tmp, so several users can create their own job directories while
 * only the owner of an entry may delete it. If we own it, force 1777 (mkdir is subject to umask).
 */
export function ensureSharedRoot(root: string): void {
	try {
		mkdirSync(root, { recursive: true, mode: 0o1777 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const first = lstatSync(root);
	if (first.isSymbolicLink() || !first.isDirectory()) {
		throw new Error(`Expected a directory, not a file or symlink: ${root}`);
	}
	if (process.getuid && first.uid === process.getuid() && (first.mode & 0o1777) !== 0o1777) {
		chmodSync(root, 0o1777);
	}
	const mode = lstatSync(root).mode;
	if ((mode & 0o1003) !== 0o1003) {
		throw new Error(`Shared job root must be sticky and world-writable (1777): ${root}`);
	}
	accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
}

/**
 * Create `path` (and parents) owner-only, or validate an existing directory the way scratchpad
 * does: reject a symlink/file, another owner, or group/other bits.
 */
export function ensurePrivateDir(path: string): void {
	try {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Expected a directory, not a file or symlink: ${path}`);
	}
	if (process.getuid && stat.uid !== process.getuid()) {
		throw new Error(`Directory must be owned by you: ${path}`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(`Directory must be owner-only (0700): ${path}`);
	}
	accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** Mirrors the host's ShellConfig so the engine stays dependency-free at load time. */
export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export interface JobStatus {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** Other processes in the group were still running when the command exited. */
	leftRunning: boolean;
}

export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already gone.
	}
}

/** True while any process in the group is alive (the leader may already have exited). */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

export function describeStatus(status: JobStatus): string {
	return status.code !== null ? `exit ${status.code}` : `killed by ${status.signal}`;
}

export function describeLeftRunning(pgid: number): string {
	return `processes started by this command are still running (process group ${pgid}; stop with \`kill -- -${pgid}\`)`;
}

export function toExitCode(status: JobStatus): number {
	return status.code ?? 128 + (status.signal ? (osConstants.signals[status.signal] ?? 0) : 0);
}

interface Registry {
	jobs: Map<string, Job>;
	files: Set<string>;
	lingeringGroups: Set<number>;
	/** Delivery used for completion and watch notifications; replaced on every extension load. */
	notify: (text: string) => void;
	onExit: () => void;
}

export const registry: Registry = ((globalThis as { __piJobs?: Registry }).__piJobs ??= (() => {
	const created: Registry = {
		jobs: new Map(),
		files: new Set(),
		lingeringGroups: new Set(),
		notify: () => {},
		onExit: () => {},
	};
	process.once("exit", () => created.onExit());
	// Forget groups that died on their own, so a later reuse of the PGID is never killed.
	setInterval(() => {
		for (const pgid of created.lingeringGroups) if (!groupAlive(pgid)) created.lingeringGroups.delete(pgid);
	}, LINGER_PRUNE_MS).unref();
	return created;
})());

registry.onExit = () => {
	for (const job of registry.jobs.values()) job.kill();
	for (const pgid of registry.lingeringGroups) killGroup(pgid);
	const dirs = new Set<string>();
	for (const file of registry.files) {
		rmSync(file, { force: true });
		dirs.add(dirname(file));
	}
	for (const dir of [...dirs, rootDir()]) {
		try {
			rmdirSync(dir);
		} catch {
			// Not empty: another pi process still has files there.
		}
	}
};

export function removeFile(path: string): void {
	rmSync(path, { force: true });
	registry.files.delete(path);
}

/** One background command from spawn to exit: a stable id, a deadline, a single exit status. */
export class Job {
	readonly id: string;
	readonly pid: number;
	readonly command: string;
	readonly name: string | undefined;
	readonly dir: string;
	readonly startedAt: number;
	/** Set once the model has been given the final status, so completion is not delivered twice. */
	observed = false;
	/** Live `job_watch` subscriptions; while any is active it owns the job's exit notification. */
	watchers = 0;
	status: JobStatus | undefined;
	readonly done: Promise<JobStatus>;
	private child: ChildProcess;
	private timedOut = false;
	private killed = false;
	private deadline: NodeJS.Timeout | undefined;

	constructor(
		child: ChildProcess,
		options: {
			id: string;
			command: string;
			name?: string;
			dir: string;
			timeoutSeconds?: number;
		},
	) {
		if (child.pid === undefined) throw new Error("command failed to start");
		this.child = child;
		this.id = options.id;
		this.pid = child.pid;
		this.command = options.command;
		this.name = options.name;
		this.dir = options.dir;
		this.startedAt = Date.now();
		if (options.timeoutSeconds !== undefined) {
			this.deadline = setTimeout(() => {
				this.timedOut = true;
				this.kill();
			}, options.timeoutSeconds * 1000);
			this.deadline.unref();
		}
		this.done = new Promise((resolve) => {
			child.once("exit", (code, signal) => {
				if (this.deadline) clearTimeout(this.deadline);
				// After our own group kill, members may still be dying; only a natural exit can leave some behind.
				const leftRunning = !this.killed && groupAlive(this.pid);
				if (leftRunning) registry.lingeringGroups.add(this.pid);
				const status: JobStatus = { code, signal, timedOut: this.timedOut, leftRunning };
				this.status = status;
				resolve(status);
			});
		});
	}

	get stdoutPath(): string {
		return join(this.dir, "stdout");
	}

	get stderrPath(): string {
		return join(this.dir, "stderr");
	}

	get statusPath(): string {
		return join(this.dir, "status");
	}

	get pgidPath(): string {
		return join(this.dir, "pgid");
	}

	get commandPath(): string {
		return join(this.dir, "command");
	}

	get startedPath(): string {
		return join(this.dir, "started");
	}

	get running(): boolean {
		return this.status === undefined;
	}

	signal(signal: NodeJS.Signals): void {
		killGroup(this.pid, signal);
	}

	kill(): void {
		this.killed = true;
		killGroup(this.pid, "SIGKILL");
	}

	/** Stop tying the job to its caller and record its status in `<id>/status` when it ends. */
	detach(): void {
		this.child.unref();
		registry.files.add(this.statusPath);
		void this.done.then((status) => {
			let text = describeStatus(status);
			if (status.timedOut) text += " (timed out)";
			if (status.leftRunning) text += `\n${describeLeftRunning(this.pid)}`;
			try {
				writeFileSync(this.statusPath, `${text}\n`);
			} catch {
				// Files already removed at pi exit.
			}
		});
	}

	/** Keep the process alive until this job exits; the counterpart to detach()'s unref. */
	keepAlive(): void {
		this.child.ref();
	}
}

export interface StartJobOptions {
	command: string;
	cwd: string;
	/** Shell to run the command with. Resolved from pi when omitted. */
	shell?: ShellConfig;
	env?: NodeJS.ProcessEnv;
	name?: string;
	timeoutSeconds?: number;
}

async function resolveShell(): Promise<ShellConfig> {
	const { getShellConfig } = await import("@earendil-works/pi-coding-agent");
	return getShellConfig();
}

export async function startJob(options: StartJobOptions): Promise<Job> {
	const shell = options.shell ?? (await resolveShell());
	const root = rootDir();
	ensureSharedRoot(root);
	const id = randomBytes(6).toString("hex");
	const dir = join(root, id);
	ensurePrivateDir(dir);
	const stdoutPath = join(dir, "stdout");
	const stderrPath = join(dir, "stderr");
	const commandFromStdin = shell.commandTransport === "stdin";

	const fds: number[] = [];
	const open = (path: string) => {
		registry.files.add(path);
		const fd = openSync(path, "w");
		fds.push(fd);
		return fd;
	};
	let child: ChildProcess;
	try {
		const outFd = open(stdoutPath);
		const errFd = open(stderrPath);
		child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, options.command], {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: [commandFromStdin ? "pipe" : "ignore", outFd, errFd],
		});
	} finally {
		for (const fd of fds) closeSync(fd);
	}
	if (commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.command);
	}
	return new Promise((resolve, reject) => {
		child.once("spawn", () => {
			const job = new Job(child, {
				id,
				command: options.command,
				name: options.name,
				dir,
				timeoutSeconds: options.timeoutSeconds,
			});
			registry.files.add(job.pgidPath);
			registry.files.add(job.commandPath);
			registry.files.add(job.startedPath);
			try {
				writeFileSync(job.pgidPath, `${job.pid}\n`);
				writeFileSync(job.commandPath, `${options.command}\n`);
				writeFileSync(job.startedPath, `${new Date(job.startedAt).toISOString()}\n`);
			} catch {
				// The job still runs; only the companion files failed.
			}
			registry.jobs.set(id, job);
			pruneJobs();
			resolve(job);
		});
		child.once("error", (error) => {
			removeFile(stdoutPath);
			removeFile(stderrPath);
			try {
				rmdirSync(dir);
			} catch {
				// Directory already gone or not empty.
			}
			reject(error);
		});
	});
}

function pruneJobs(): void {
	if (registry.jobs.size <= MAX_RETAINED_JOBS) return;
	for (const [id, job] of registry.jobs) {
		if (registry.jobs.size <= MAX_RETAINED_JOBS) break;
		if (!job.running) registry.jobs.delete(id);
	}
}

export function getJob(id: string): Job | undefined {
	return registry.jobs.get(id);
}

/** Live and recently finished jobs, newest first. */
export function listJobs(): Job[] {
	return [...registry.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Forward bytes appended to `path`, starting at `startOffset`, into `onData` until stopped. */
export function tailFile(
	path: string,
	onData: (data: Buffer) => void,
	pollMs = 100,
	startOffset = 0,
): { stop(): void } {
	const fd = openSync(path, "r");
	const buffer = Buffer.alloc(64 * 1024);
	let offset = startOffset;
	const drain = () => {
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, offset);
			if (n <= 0) return;
			offset += n;
			onData(Buffer.from(buffer.subarray(0, n)));
		}
	};
	const timer = setInterval(drain, pollMs);
	timer.unref();
	return {
		stop() {
			clearInterval(timer);
			drain();
			closeSync(fd);
		},
	};
}

/** Last `lines` lines of `path`, reading at most `maxBytes` from the end. */
export function readTail(path: string, lines: number, maxBytes = 64 * 1024): string {
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(size - start);
			if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, start);
			let text = buffer.toString("utf8");
			if (start > 0) text = text.replace(/^[^\n]*\n?/, "");
			const all = text.split("\n");
			if (all[all.length - 1] === "") all.pop();
			return all.slice(-lines).join("\n");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * Watch seed: the last `lines` complete lines of `path`, any trailing partial line, and the byte
 * offset a follower resumes from. Reads [size-maxBytes, size) and resumes at `size`, so the partial
 * is held rather than lost and no byte is read twice.
 */
export function readTailSeed(
	path: string,
	lines: number,
	maxBytes = 64 * 1024,
): { seedLines: string[]; partial: string; offset: number } {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return { seedLines: [], partial: "", offset: 0 };
	}
	const start = Math.max(0, size - maxBytes);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size - start);
		if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start > 0) text = text.replace(/^[^\n]*\n?/, "");
		const complete = text.split("\n");
		const partial = complete.pop() ?? "";
		return { seedLines: complete.slice(-lines), partial, offset: size };
	} finally {
		closeSync(fd);
	}
}
