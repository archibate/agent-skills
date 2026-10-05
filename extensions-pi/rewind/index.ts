/**
 * Rewind: per-prompt file checkpoints for pi.
 *
 * Captures the pre-image of every file pi's `edit`/`write` tools touch, keyed by
 * the user prompt that started the agent run. `/rewind` (or `Ctrl+Alt+R`) then
 * offers to restore code, conversation, or both.
 *
 * Conversation rewind stays exactly as pi's own `/tree` and `/fork`: this
 * extension never restores files unless you pick that action. It is an added
 * capability, not a replacement for those commands.
 *
 * Scope limits, shared with Claude Code's checkpoints: files changed by `bash`,
 * the user's editor, or tools other than `edit`/`write` are not captured.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BlobStore,
	type Checkpoint,
	type CheckpointStat,
	type RestoreReport,
	type SnapshotFile,
	applyRestore,
	isRestorableFile,
	planRestore,
	summarizeCheckpoints,
	toWorkspaceRelative,
} from "./store.ts";
import { type MenuEntry, pickCheckpoint } from "./menu.ts";

const REWIND_ENTRY_TYPE = "rewind";
const DEFAULT_MAX_CHECKPOINTS = 100;
/** Pre-image bytes kept per session. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Files larger than this are not captured: a single huge file must not blow the budget. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
// Matches pi's own session-id assertion: alphanumerics plus '-', '_', '.', so the id is one path component.
const VALID_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const ACTIONS = [
	"Restore code and conversation",
	"Restore conversation only",
	"Restore code only",
	"Never mind",
] as const;

/** Longest user-prompt preview shown in the picker, in characters. */
const PROMPT_PREVIEW_MAX = 60;

interface Config {
	enabled: boolean;
	maxCheckpoints: number;
	maxBytes: number;
	maxFileBytes: number;
}

interface OpenRun {
	files: Map<string, SnapshotFile>;
	/** Bytes stored for this run, so one prompt cannot exceed maxBytes on its own. */
	bytes: number;
}

/** Pi's agent directory, matching getAgentDir() from the package without a runtime import. */
function agentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv) return fromEnv.replace(/^~(?=$|[\\/])/, homedir());
	return join(homedir(), ".pi", "agent");
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function loadConfig(): Config {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir(), "rewind.json"), "utf8")) as Partial<Config>;
		return {
			enabled: raw.enabled !== false,
			maxCheckpoints: positiveInt(raw.maxCheckpoints, DEFAULT_MAX_CHECKPOINTS),
			maxBytes: positiveInt(raw.maxBytes, DEFAULT_MAX_BYTES),
			maxFileBytes: positiveInt(raw.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
		};
	} catch {
		return {
			enabled: true,
			maxCheckpoints: DEFAULT_MAX_CHECKPOINTS,
			maxBytes: DEFAULT_MAX_BYTES,
			maxFileBytes: DEFAULT_MAX_FILE_BYTES,
		};
	}
}

/** The checkpoint anchor is the prompt's user message, which is the last user message on the branch. */
function resolveUserEntryId(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry) continue;
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
	}
	return ctx.sessionManager.getLeafId() ?? undefined;
}

/** One-line preview of the user prompt that anchored a checkpoint, if it is still in the session. */
function promptPreview(ctx: ExtensionCommandContext, entryId: string): string | undefined {
	const entry = ctx.sessionManager.getEntry(entryId);
	if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	const text =
		typeof content === "string"
			? content
			: content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	return oneLine.length > PROMPT_PREVIEW_MAX ? `${oneLine.slice(0, PROMPT_PREVIEW_MAX - 1)}…` : oneLine;
}

function label(checkpoint: Checkpoint, index: number, prompt: string | undefined, stat: CheckpointStat | undefined): string {
	const time = new Date(checkpoint.timestamp).toLocaleTimeString();
	const names = checkpoint.files.slice(0, 3).map((file) => file.path).join(", ");
	const more = checkpoint.files.length > 3 ? `, +${checkpoint.files.length - 3}` : "";
	const parts = [`${index + 1}. ${time}`];
	if (prompt) parts.push(`"${prompt}"`);
	if (stat) parts.push(`+${stat.totalAdded} -${stat.totalRemoved}`);
	parts.push(`${names}${more}`);
	return parts.join(" · ");
}

/**
 * Ask which checkpoint to rewind to.
 *
 * TUI mode gets a multi-line, colored picker; other UI modes (RPC, print) keep
 * the one-line selector. The pi-tui helpers are imported lazily so this module
 * and its tests never need the terminal runtime.
 */
async function pickTarget(
	ctx: ExtensionCommandContext,
	ordered: Checkpoint[],
	prompts: Map<Checkpoint, string | undefined>,
	stats: Map<Checkpoint, CheckpointStat> | undefined,
): Promise<Checkpoint | undefined> {
	if (ctx.mode === "tui") {
		const lib = await import("@earendil-works/pi-tui");
		const entries: MenuEntry[] = ordered.map((checkpoint) => {
			const stat = stats?.get(checkpoint);
			return {
				time: new Date(checkpoint.timestamp).toLocaleTimeString(),
				prompt: prompts.get(checkpoint),
				added: stat?.totalAdded ?? 0,
				removed: stat?.totalRemoved ?? 0,
				files: stat?.files ?? checkpoint.files.map((file) => ({ path: file.path, added: 0, removed: 0, skipped: file.skipped !== undefined })),
			};
		});
		const picked = await pickCheckpoint(ctx, { truncateToWidth: lib.truncateToWidth }, entries);
		return picked === undefined ? undefined : ordered[picked];
	}
	const labels = ordered.map((checkpoint, index) =>
		label(checkpoint, index, prompts.get(checkpoint), stats?.get(checkpoint)),
	);
	const picked = await ctx.ui.select("Rewind to which prompt?", labels);
	if (picked === undefined) return undefined;
	return ordered[labels.indexOf(picked)];
}

function describe(report: RestoreReport): string {
	const parts: string[] = [];
	if (report.restored.length) parts.push(`${report.restored.length} restored`);
	if (report.deleted.length) parts.push(`${report.deleted.length} deleted`);
	if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
	if (report.unrestorable.length) parts.push(`${report.unrestorable.length} not captured`);
	if (report.missing.length) parts.push(`${report.missing.length} missing`);
	const hint = report.unrestorable.length ? " Uncaptured files were larger than maxFileBytes or past maxBytes." : "";
	return (parts.length ? `Code rewind: ${parts.join(", ")}.` : "Code rewind: nothing to change.") + hint;
}

function notify(ctx: ExtensionCommandContext | ExtensionContext, text: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(text, type);
	else console.log(text);
}

export default function rewindExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	let blobs: BlobStore | undefined;
	let checkpoints: Checkpoint[] = [];
	let nextSeq = 1;
	let open: OpenRun | undefined;

	const referenced = (): Set<string> => {
		const hashes = new Set<string>();
		for (const checkpoint of checkpoints) {
			for (const file of checkpoint.files) if (file.hash) hashes.add(file.hash);
		}
		return hashes;
	};

	const referencedBytes = (): number => {
		if (!blobs) return 0;
		let total = 0;
		for (const hash of referenced()) total += blobs.sizeOf(hash);
		return total;
	};

	/** Drop oldest checkpoints until the count and byte budgets hold, then release their blobs. */
	const trim = (): void => {
		if (!blobs) return;
		let dropped = false;
		for (;;) {
			const overCount = checkpoints.length > config.maxCheckpoints;
			if (checkpoints.length <= 1 || (!overCount && referencedBytes() <= config.maxBytes)) break;
			const before = referencedBytes();
			checkpoints.shift();
			dropped = true;
			// Evicting can free nothing when newer checkpoints share the blob; stop rather than
			// discard history for no gain. The captured run itself is capped at maxBytes.
			if (!overCount && referencedBytes() >= before) break;
		}
		if (dropped) blobs.gc(referenced());
	};

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		open = undefined;
		checkpoints = [];
		nextSeq = 1;
		blobs = undefined;
		if (!config.enabled) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!VALID_SESSION_ID.test(sessionId)) return;
		blobs = new BlobStore(join(agentDir(), "rewind", sessionId));
		// Restore is chronological, so checkpoints are collected across branches, not just the active one.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== REWIND_ENTRY_TYPE) continue;
			const data = entry.data as Checkpoint | undefined;
			if (!data || typeof data !== "object" || typeof data.entryId !== "string" || !Array.isArray(data.files)) continue;
			checkpoints.push(data);
		}
		checkpoints.sort((a, b) => a.seq - b.seq);
		nextSeq = checkpoints.reduce((max, checkpoint) => Math.max(max, checkpoint.seq + 1), 1);
		trim();
		// Also reclaim blobs no surviving checkpoint references: leftovers from a run that crashed
		// before its entry was committed. Assumes one live pi process per session id.
		blobs.gc(referenced());
	});

	pi.on("before_agent_start", () => {
		if (!config.enabled) return;
		open = { files: new Map(), bytes: 0 };
	});

	pi.on("tool_call", (event, ctx) => {
		if (!config.enabled || !blobs) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		// A continuation after the settle boundary has no fresh before_agent_start.
		open ??= { files: new Map(), bytes: 0 };
		// Capture is best effort: a failed snapshot must never block the tool call.
		try {
			const path = event.input.path;
			if (typeof path !== "string") return;
			const relPath = toWorkspaceRelative(ctx.cwd, path);
			if (relPath === undefined || open.files.has(relPath)) return;
			const absolute = resolve(ctx.cwd, relPath);
			if (!existsSync(absolute)) {
				open.files.set(relPath, { path: relPath, hash: "", existed: false });
				return;
			}
			if (!isRestorableFile(absolute)) return;
			const size = statSync(absolute).size;
			if (size > config.maxFileBytes) {
				open.files.set(relPath, { path: relPath, hash: "", existed: true, skipped: "too-large" });
				return;
			}
			if (open.bytes + size > config.maxBytes) {
				open.files.set(relPath, { path: relPath, hash: "", existed: true, skipped: "over-budget" });
				return;
			}
			open.files.set(relPath, { path: relPath, hash: blobs.put(readFileSync(absolute)), existed: true });
			open.bytes += size;
		} catch {
			// Ignore unreadable or unwritable paths.
		}
	});

	/** Turn the open run's captures into a checkpoint, or undefined when there is nothing to save. */
	const buildCheckpoint = (ctx: ExtensionContext): Checkpoint | undefined => {
		const run = open;
		open = undefined;
		if (!config.enabled || !blobs || !run || run.files.size === 0) return undefined;
		// Resolve at settle: the branch is complete, so the last user message is this run's prompt.
		const entryId = resolveUserEntryId(ctx);
		if (!entryId) return undefined;
		const checkpoint: Checkpoint = {
			entryId,
			seq: nextSeq++,
			timestamp: Date.now(),
			files: [...run.files.values()],
		};
		checkpoints.push(checkpoint);
		trim();
		return checkpoint;
	};

	pi.on("agent_before_settle", (_event, ctx) => {
		const checkpoint = buildCheckpoint(ctx);
		if (!checkpoint) return;
		return { entries: [{ type: "custom", customType: REWIND_ENTRY_TYPE, data: checkpoint }] };
	});

	pi.on("agent_settled", (_event, ctx) => {
		// An aborted run never reaches the settle boundary, so persist its captures here.
		const checkpoint = buildCheckpoint(ctx);
		if (checkpoint) pi.appendEntry(REWIND_ENTRY_TYPE, checkpoint);
	});

	pi.registerCommand("rewind", {
		description: "Restore files to a previous prompt (file checkpoints)",
		handler: async (_args, ctx) => {
			if (!config.enabled) {
				notify(
					ctx,
					'File checkpoints are disabled. Set "enabled": true in ~/.pi/agent/rewind.json and run /reload.',
					"warning",
				);
				return;
			}
			if (checkpoints.length === 0) {
				notify(ctx, "No file checkpoints in this session yet. Checkpoints are created when pi edits files.", "info");
				return;
			}
			if (!ctx.hasUI) {
				notify(ctx, `File checkpoints: ${checkpoints.length}`, "info");
				return;
			}
			const ordered = [...checkpoints].reverse();
			const prompts = new Map(ordered.map((checkpoint) => [checkpoint, promptPreview(ctx, checkpoint.entryId)]));
			const stats = blobs ? summarizeCheckpoints(ctx.cwd, checkpoints, blobs) : undefined;
			const target = await pickTarget(ctx, ordered, prompts, stats);
			if (!target) return;
			const action = await ctx.ui.select(label(target, 0, prompts.get(target), stats?.get(target)), [...ACTIONS]);
			if (!action || action === "Never mind") return;

			const restoreCode = action !== "Restore conversation only";
			const restoreConversation = action !== "Restore code only";
			if (restoreCode && blobs) {
				const report = applyRestore(ctx.cwd, planRestore(checkpoints, target), blobs);
				const incomplete = report.missing.length > 0 || report.unrestorable.length > 0;
				notify(ctx, describe(report), incomplete ? "warning" : "info");
			}
			if (restoreConversation) {
				try {
					const result = await ctx.navigateTree(target.entryId);
					if (result.cancelled) {
						notify(ctx, restoreCode ? "Code restored, but the conversation rewind was cancelled." : "Conversation rewind cancelled.", "warning");
					}
				} catch (error) {
					notify(ctx, `Conversation rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
		},
	});

	// Shortcut handlers only get a base ExtensionContext, which has no
	// navigateTree. Re-dispatch through the command pipeline so the shortcut
	// runs with the same command context as typing /rewind.
	pi.registerShortcut("ctrl+alt+r", {
		description: "Restore files to a previous prompt (file checkpoints)",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				notify(ctx, "Wait for the current response to finish before rewinding.", "warning");
				return;
			}
			pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
		},
	});
}
