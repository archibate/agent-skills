/**
 * jobs extension: explicit background jobs, files as the API.
 *
 * `bash` stays native pi (foreground, timeout-gated); this extension injects a default timeout so
 * a forgotten long command cannot hang forever, appends a `job_start` hint when that timeout fires,
 * and holds one-shot (print/JSON) runs open while jobs are pending so their completion reaches the
 * agent instead of being killed by process exit.
 *
 * Only two tools are declared. Everything else is the filesystem: `job_start` returns a job id and
 * its directory, and the model operates it with bash (grep, tail, kill, wait on the `status` file).
 * `job_watch` exists because pushing lines into the agent needs the in-process runtime.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	describeLeftRunning,
	describeStatus,
	getJob,
	type Job,
	listJobs,
	readTail,
	readTailSeed,
	registry,
	rootDir,
	startJob,
	tailFile,
} from "./jobs.ts";

const DEFAULT_BASH_TIMEOUT_SECONDS = readEnvInt("PI_JOBS_BASH_TIMEOUT_SECONDS", 120);
/** Per-job liveness backoff: first nudge this many seconds after a job starts, doubling to the cap. */
const HEARTBEAT_BASE_SECONDS = readEnvInt("PI_JOBS_HEARTBEAT_SECONDS", 120);
const HEARTBEAT_MAX_SECONDS = 3600;
const HEARTBEAT_TAIL_LINES = 20;
const WATCH_DEFAULT_SECONDS = 600;
const WATCH_MAX_SECONDS = 3600;
const WATCH_SEED_LINES = 20;
const BATCH_MS = 1000;
const MAX_LINES_PER_EVENT = 20;
const FLOOD_EVENTS = 10;
const FLOOD_WINDOW_MS = 60_000;
const POLL_MS = 100;
const MAX_WATCHERS = 16;
let activeWatchers = 0;

function guideline(root: string): string {
	return (
		"Long-running commands: use the job_start tool instead of bash. Each job gets an owner-only " +
		`directory under ${root}/<id>/ with command/stdout/stderr/status/pgid/started files; ` +
		"inspect it with bash (grep, tail), wait for the status file, stop with kill -- -<pgid>, and use " +
		"job_watch to be notified of output instead of polling."
	);
}

function readEnvInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, Math.floor(value)));
}

function label(job: Job): string {
	return `job ${job.id}${job.name ? ` "${job.name}"` : ""}`;
}

function deliver(text: string): void {
	try {
		registry.notify(text);
	} catch {
		// The runtime may have been replaced by /reload; the newest load owns delivery.
	}
}

function requireJob(id: string): Job {
	const job = getJob(id);
	if (!job) {
		throw new Error(
			`No job with id ${JSON.stringify(id)}. List jobs with: ls -la ${JSON.stringify(rootDir())}`,
		);
	}
	return job;
}

function statusLine(job: Job): string {
	const status = job.status;
	if (!status) {
		const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
		return `running (PID ${job.pid}, ${elapsed}s)`;
	}
	let text = describeStatus(status);
	if (status.timedOut) text += " (timed out)";
	if (status.leftRunning) text += `. ${describeLeftRunning(job.pid)}`;
	return text;
}

function truncate(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length)}...`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** Byte size and modification age of a job file, so the agent can judge progress from the nudge. */
function fileActivity(path: string, now: number): string {
	try {
		const stat = statSync(path);
		return `${stat.size}B (${formatDuration(now - stat.mtimeMs)} ago)`;
	} catch {
		return "absent";
	}
}

/** One liveness nudge listing every due job, so the agent can heal or kill the stuck ones. */
function heartbeatMessage(due: Job[], running: Job[], now: number): string {
	const lines = [
		`Liveness check: ${due.length} job(s) still running. Confirm each is making progress — tail its output, then heal or kill if stuck.`,
	];
	for (const job of due) {
		lines.push(
			`[${label(job)}] ${formatDuration(now - job.startedAt)} elapsed (pgid ${job.pid}) · ` +
				`stdout ${fileActivity(job.stdoutPath, now)} · stderr ${fileActivity(job.stderrPath, now)}`,
			`  tail -n ${HEARTBEAT_TAIL_LINES} ${job.stdoutPath}`,
			`  kill -- -${job.pid}`,
		);
	}
	const other = running.length - due.length;
	if (other > 0) lines.push(`(${other} other running job(s) not shown)`);
	return lines.join("\n");
}

/** Session environment for a job, matching what the bash tool injects (so `$PI_SESSION_ID` etc. work). */
function sessionEnv(ctx: ExtensionToolContext): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function jobContract(job: Job): string {
	return (
		`Started ${label(job)} (pgid ${job.pid}). Dir: ${job.dir} ` +
		"(stdout, stderr, status inside). You will be notified when it exits."
	);
}

/** Tail a running job's log and deliver matching lines, with batching and flood protection. */
function watchJob(job: Job, pattern: RegExp | undefined, timeoutSeconds: number): void {
	const tag = `[${label(job)}]`;
	const seed = readTailSeed(job.stdoutPath, WATCH_SEED_LINES);
	let partial = seed.partial;
	let pending: string[] = [];
	let batchTimer: NodeJS.Timeout | undefined;
	const eventTimes: number[] = [];
	let flooded = false;
	let stopped = false;

	const stop = (reason: string) => {
		if (stopped) return;
		stopped = true;
		tail.stop();
		clearTimeout(batchTimer);
		clearTimeout(expiry);
		if (partial) {
			if (!pattern || pattern.test(partial)) pending.push(partial);
			partial = "";
		}
		const batch = flooded ? undefined : pending.slice(0, MAX_LINES_PER_EVENT).join("\n");
		pending = [];
		activeWatchers--;
		job.watchers--;
		deliver(`${tag} ${reason}${batch ? `\n${batch}` : ""}`);
	};

	const flush = () => {
		batchTimer = undefined;
		if (pending.length === 0 || flooded || stopped) return;
		const shown = pending.slice(0, MAX_LINES_PER_EVENT);
		const extra = pending.length - shown.length;
		pending = [];
		const now = Date.now();
		while (eventTimes.length > 0 && now - eventTimes[0]! > FLOOD_WINDOW_MS) eventTimes.shift();
		eventTimes.push(now);
		if (eventTimes.length > FLOOD_EVENTS) {
			flooded = true;
			stop(`stopped: more than ${FLOOD_EVENTS} notifications in ${FLOOD_WINDOW_MS / 1000}s`);
			return;
		}
		deliver(`${tag}\n${shown.join("\n")}${extra > 0 ? `\n(+${extra} more lines in ${job.stdoutPath})` : ""}`);
	};

	const onData = (data: Buffer) => {
		const lines = (partial + data.toString("utf8")).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) if (!pattern || pattern.test(line)) pending.push(line);
		if (pending.length > 0 && !batchTimer && !flooded) batchTimer = setTimeout(flush, BATCH_MS);
	};

	const tail = tailFile(job.stdoutPath, onData, POLL_MS, seed.offset);
	const expiry = setTimeout(() => stop(`watch expired after ${timeoutSeconds}s`), timeoutSeconds * 1000);
	expiry.unref();
	// Replay recent output first, so a watch attached after the job started does not miss it.
	for (const line of seed.seedLines) if (!pattern || pattern.test(line)) pending.push(line);
	if (pending.length > 0) flush();
	void job.done.then((status) => stop(`${describeStatus(status)}${status.timedOut ? " (timed out)" : ""}`));
}

export default function jobsExtension(pi: ExtensionAPI): void {
	registry.notify = (text) => {
		pi.sendMessage({ customType: "job", content: text, display: true }, { triggerTurn: true, deliverAs: "steer" });
	};

	// Keep bash native, but bound a forgotten command and route long work to job_start.
	pi.on("tool_call", (event) => {
		if (DEFAULT_BASH_TIMEOUT_SECONDS <= 0 || event.toolName !== "bash") return;
		if (event.input && event.input.timeout === undefined) event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !event.isError) return;
		const text = event.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("\n");
		if (!/Command timed out after \d+ seconds/.test(text)) return;
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: "For work that should outlive this call, use job_start to run it in the background; it returns the job's directory and notifies you on exit.",
				},
			],
			details: event.details,
			structuredContent: event.structuredContent,
		};
	});

	pi.on("before_agent_start", (event) => {
		const guidelines = event.systemPromptOptions.promptGuidelines;
		const text = guideline(rootDir());
		if (!guidelines.includes(text)) guidelines.push(text);
	});

	// One-shot modes (print/json) exit the process as soon as the run settles, which would kill
	// pending jobs before their completion notification reached the agent. Hold settlement while
	// jobs run: re-ref their child handles so the process stays alive. Each running job also gets a
	// per-job liveness heartbeat on an exponential backoff, so a job that never exits surfaces to the
	// agent for a heal-or-kill decision instead of hanging the run forever.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		const running = listJobs().filter((job) => job.running);
		if (running.length === 0) return;
		for (const job of running) job.keepAlive();
		if (HEARTBEAT_BASE_SECONDS <= 0) {
			await Promise.race(running.map((job) => job.done));
			return { continue: true };
		}

		const reportDue = (): boolean => {
			const now = Date.now();
			const live = listJobs().filter((job) => job.running);
			const due = live.filter((job) => job.heartbeatDue(now));
			if (due.length === 0) return false;
			deliver(heartbeatMessage(due, live, now));
			for (const job of due) job.advanceHeartbeat(now, HEARTBEAT_MAX_SECONDS);
			return true;
		};

		for (const job of running) {
			if (job.heartbeatAt === undefined) job.scheduleHeartbeat(HEARTBEAT_BASE_SECONDS);
		}
		// A job already past its first interval (started several turns ago) is reported immediately.
		if (reportDue()) return { continue: true };

		const next = Math.min(...running.map((job) => job.heartbeatAt ?? Number.POSITIVE_INFINITY));
		let timer: NodeJS.Timeout | undefined;
		const tick = new Promise<"tick">((resolve) => {
			timer = setTimeout(() => resolve("tick"), Math.max(1, next - Date.now()));
		});
		try {
			const winner = await Promise.race([
				...running.map((job) => job.done.then(() => "done" as const)),
				tick,
			]);
			if (winner === "tick") reportDue();
		} finally {
			if (timer) clearTimeout(timer);
		}
		return { continue: true };
	});

	pi.registerTool({
		name: "job_start",
		label: "job_start",
		description:
			"Start a shell command in the background and return its job id, process group, and file " +
			"directory. The command outlives this call and you are notified when it exits. Inspect and " +
			"control it with bash: grep/tail the stdout file, wait on the status file, `kill -- -<pgid>` " +
			"to stop the group. Only for long-running work; use bash for quick commands.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run in the background." }),
			name: Type.Optional(Type.String({ description: "Short label used in notifications (e.g. \"build\")." })),
			timeout: Type.Optional(
				Type.Number({ minimum: 1, description: "Seconds until the job is killed (optional, no default)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			const job = await startJob({
				command: params.command,
				cwd: ctx.cwd,
				shell: getShellConfig(),
				env: sessionEnv(ctx),
				name: params.name,
				timeoutSeconds: params.timeout,
			});
			job.detach();
			void job.done.then((status) => {
				// A live watch delivers its own exit message (with matched output), so defer to it.
				if (job.observed || job.watchers > 0) return;
				job.observed = true;
				deliver(`[${label(job)}] finished: ${statusLine(job)}\n${readTail(job.stdoutPath, 20)}`);
			});
			return {
				content: [{ type: "text", text: jobContract(job) }],
				details: { id: job.id, pid: job.pid, dir: job.dir },
			};
		},
	});

	pi.registerTool({
		name: "job_watch",
		label: "job_watch",
		description:
			"Watch a running job's output: recent matching lines are replayed first, then new ones " +
			"arrive as messages while you keep working or after your turn ends. Use it instead of " +
			"polling. Ends when the job exits, the timeout fires, or the output floods. The id comes " +
			"from job_start.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id from job_start." }),
			pattern: Type.Optional(
				Type.String({ description: "Case-insensitive regular expression; only matching lines are delivered." }),
			),
			timeout: Type.Optional(
				Type.Number({ description: `Seconds until the watch stops (default ${WATCH_DEFAULT_SECONDS}).` }),
			),
		}),
		async execute(_toolCallId, params) {
			const job = requireJob(params.id);
			let pattern: RegExp | undefined;
			if (params.pattern !== undefined) {
				try {
					pattern = new RegExp(params.pattern, "i");
				} catch (error) {
					throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (activeWatchers >= MAX_WATCHERS) throw new Error(`Too many active job watches (max ${MAX_WATCHERS}).`);
			const seconds = clamp(params.timeout ?? WATCH_DEFAULT_SECONDS, 1, WATCH_MAX_SECONDS);
			activeWatchers++;
			job.watchers++;
			try {
				watchJob(job, pattern, seconds);
			} catch (error) {
				activeWatchers--;
				job.watchers--;
				throw error;
			}
			return {
				content: [
					{
						type: "text",
						text: `Watching ${label(job)}${pattern ? ` for /${params.pattern}/` : ""}. Recent output is replayed, then new matching lines arrive as messages; the watch stops when the job exits or after ${seconds}s.`,
					},
				],
				details: { id: job.id },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "List background jobs",
		handler: async (_args, ctx) => {
			const jobs = listJobs();
			const text =
				jobs.length === 0
					? "No jobs."
					: jobs.map((job) => `${label(job)}: ${statusLine(job)} - ${truncate(job.command, 100)}`).join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
