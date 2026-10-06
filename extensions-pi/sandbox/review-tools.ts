/** Reviewer-only queries: no extension implementations, shell, downloads, or user rg config. */
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, opendir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "@earendil-works/pi-coding-agent";
import { prepareSandbox } from "./sandbox.ts";

export const REVIEW_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const FILE_BYTES = 4 * 1024 * 1024;
const OUTPUT_BYTES = 16 * 1024;

async function reviewTarget(path: string): Promise<string> {
	const target = await realpath(path);
	if (["/dev", "/proc", "/sys"].some((root) => target === root || target.startsWith(`${root}/`))) throw new Error("Reviewer queries exclude device and process pseudo-filesystems");
	const info = await stat(target);
	if (!info.isFile() && !info.isDirectory()) throw new Error("Reviewer queries require an ordinary file or directory");
	return target;
}

/** Bound allocation before reading; nonblocking open and fstat also reject pipes/devices. */
export async function readReviewFile(path: string): Promise<Buffer> {
	const target = await reviewTarget(path);
	const before = await stat(target);
	if (!before.isFile() || before.size > FILE_BYTES) throw new Error("Reviewer reads require a regular file of at most 4 MiB");
	// Linux O_PATH (010000000): resolve without invoking a device's open handler. Node omits it.
	if (process.platform !== "linux") throw new Error("Automatic reviewer reads require Linux");
	const pinned = await open(target, 0x200000 | constants.O_NOFOLLOW);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const pinnedStat = await pinned.stat();
		if (!pinnedStat.isFile() || pinnedStat.size > FILE_BYTES) throw new Error("Reviewer read target changed or is not a bounded regular file");
		file = await open(`/proc/self/fd/${pinned.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > FILE_BYTES) throw new Error("Reviewer reads require a regular file of at most 4 MiB");
		const buffer = Buffer.alloc(FILE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > FILE_BYTES) throw new Error("Reviewer file exceeded 4 MiB while reading");
		const result = buffer.subarray(0, size);
		if (result.includes(0) || !isUtf8(result)) throw new Error("Binary/image inspection is not supported by the automatic reviewer");
		return result;
	} finally {
		try { await file?.close(); } finally { await pinned.close(); }
	}
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new Error("Invalid reviewer query limit");
	return Math.min(value, max);
}

/** Fixed programs and argv; hard output cap and cancellation, never a shell or auto-install. */
async function query(program: string, args: string[], cwd: string, signal: AbortSignal | undefined, prepare: typeof prepareSandbox): Promise<string> {
	if (signal?.aborted) throw new Error("Review query cancelled");
	const sandbox = await prepare({ processAccess: "disable" }, cwd);
	try {
		const command = sandbox.shell({ shell: program, args });
		return await new Promise((done, fail) => {
			if (signal?.aborted) return fail(new Error("Review query cancelled"));
			const child = spawn(command.shell, command.args, { cwd, env: sandbox.env(process.env), stdio: ["ignore", "pipe", "pipe"] });
			const chunks: Buffer[] = [];
			let bytes = 0;
			let error = "";
			let truncated = false;
			const abort = () => { child.kill("SIGKILL"); fail(new Error("Review query cancelled")); };
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				const remaining = OUTPUT_BYTES - bytes;
				if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
				if (chunk.length > remaining) { truncated = true; child.kill("SIGKILL"); }
			});
			child.stderr.on("data", (chunk: Buffer) => { if (error.length < 4096) error += chunk.toString("utf8").slice(0, 4096 - error.length); });
			child.once("error", (e) => { signal?.removeEventListener("abort", abort); fail(e); });
			child.once("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) return fail(new Error("Review query cancelled"));
				if (!truncated && code !== 0 && !(program.endsWith("/rg") && code === 1 && error.length === 0)) return fail(new Error(error || `Query exited ${code}`));
				const output = Buffer.concat(chunks).toString("utf8");
				done(truncated ? `[Query output truncated at 16 KiB; inspect a narrower target.]\n${output}` : output || "No results");
			});
		});
	} finally {
		await sandbox.dispose();
	}
}

/** `prepare` is an internal test seam; production always uses the access sandbox. */
export function createReviewTools(cwd: string, prepare: typeof prepareSandbox = prepareSandbox): AgentTool[] {
	const read = createReadTool(cwd, { operations: { readFile: readReviewFile, access, detectImageMimeType: async () => null } });
	return [read, createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)].map((tool): AgentTool => ({
		...tool,
		description: tool.name === "read" ? "Read a regular text file (up to 4 MiB)." : tool.description,
		async execute(id, raw, signal, update) {
			if (signal?.aborted) throw new Error("Review query cancelled");
			const args = raw as Record<string, unknown>;
			if (tool.name === "read") return read.execute(id, { path: String(args.path), offset: args.offset === undefined ? undefined : integer(args.offset, 1, 1, 1_000_000), limit: integer(args.limit, 200, 1, 1000) }, signal, update);
			const limit = integer(args.limit, 100, 1, 200);
			const path = await reviewTarget(typeof args.path === "string" ? resolve(cwd, args.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : cwd);
			let output: string;
			if (tool.name === "grep") {
				const flags = ["--no-config", "--one-file-system", "--threads", "1", "--max-filesize", "4M", "--max-count", String(limit), "--line-number", "--with-filename", "--color", "never"];
				if (args.ignoreCase) flags.push("--ignore-case");
				if (args.literal) flags.push("--fixed-strings");
				if (typeof args.glob === "string") flags.push(`--glob=${args.glob}`);
				flags.push("--context", String(integer(args.context, 0, 0, 8)), "--", String(args.pattern), path);
				output = await query("/usr/bin/rg", flags, cwd, signal, prepare);
			} else if (tool.name === "find") {
				output = await query("/usr/bin/fd", ["--one-file-system", "--threads", "1", "--max-results", String(limit), "--type", "f", "--absolute-path", "--glob", "--color", "never", "--", String(args.pattern), path], cwd, signal, prepare);
			} else {
				const dir = await opendir(path);
				const names: string[] = [];
				let truncated = false;
				let bytes = 0;
				try {
					for await (const entry of dir) {
						if (signal?.aborted) throw new Error("Review query cancelled");
						const name = entry.name + (entry.isDirectory() ? "/" : "");
						bytes += Buffer.byteLength(name) + 1;
						if (names.length >= limit || bytes > OUTPUT_BYTES) { truncated = true; break; }
						names.push(name);
					}
				} finally {
					await dir.close().catch((e: NodeJS.ErrnoException) => { if (e.code !== "ERR_DIR_CLOSED") throw e; });
				}
				output = names.slice(0, limit).sort().join("\n") || "Empty directory";
				if (truncated) output += "\n[Listing truncated; narrow the path.]";
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	}));
}
