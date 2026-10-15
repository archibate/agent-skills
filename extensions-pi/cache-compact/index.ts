/**
 * cache-compact: summarize in a fork of the session so the summary request reuses
 * the conversation's prompt cache.
 *
 * Like /btw (../btw), the fork is an in-memory session seeded with the whole branch,
 * the same session id, model, thinking level, tools and reloaded extensions, so its
 * request is the main session's next request: the cached prefix plus one user
 * message asking for the summary. Every API works the same way, and nothing is
 * kept between compactions, so behavior does not depend on timing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { addFileOps, archiveNotice, buildInstruction, type FileOps, fileLists } from "./compaction.ts";

/** Report a cache miss when less than this share of the previous prompt is read from cache. */
const MISS_RATIO = 0.5;

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface CacheCompactOptions {
	/** Global config directory for the fork. Default: Pi's agent dir. */
	agentDir?: string;
	/** Extra resource loader options for the fork (tests). */
	resourceLoaderOptions?: Partial<DefaultResourceLoaderOptions>;
}

/** The fork may not run tools, and shares the main session's OpenAI-style cache key. */
function forkTweaks(mainSessionId: string) {
	return (api: ExtensionAPI) => {
		api.on("tool_call", () => ({ block: true, reason: "Tools are disabled while summarizing for compaction" }));
		api.on("before_provider_request", (event) => {
			const payload = event.payload as Record<string, unknown> | undefined;
			if (payload && typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0) {
				payload.prompt_cache_key = mainSessionId;
			}
			return undefined;
		});
	};
}

async function createFork(ctx: ExtensionContext, tools: string[], options: CacheCompactOptions): Promise<AgentSession> {
	const mainSessionId = ctx.sessionManager.getSessionId();
	const agentDir = options.agentDir ?? getAgentDir();
	// The fork's context is near the limit: it must not compact (recursively) or warm caches.
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
	settingsManager.applyOverrides({ compaction: { enabled: false }, cacheWarming: "off" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		...options.resourceLoaderOptions,
		extensionFactories: [...(options.resourceLoaderOptions?.extensionFactories ?? []), forkTweaks(mainSessionId)],
	});
	await resourceLoader.reload({ resolveProjectTrust: async () => ctx.isProjectTrusted() });
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		model: ctx.model,
		...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
		tools,
		// The same id keeps system prompts that embed it, and cache keys derived from it, identical.
		sessionManager: SessionManager.inMemory(ctx.cwd, { id: mainSessionId }, ctx.sessionManager.getBranch()),
		settingsManager,
		resourceLoader,
	});
	// The SDK does not bind extensions; their request hooks must run as in the main session.
	await session.bindExtensions({ mode: "print" });
	return session;
}

/** Prompt tokens of the main session's last request, for the cache-miss report. */
function lastPromptTokens(ctx: ExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return undefined;
}

async function summarize(fork: AgentSession, instruction: string, signal: AbortSignal): Promise<AssistantMessage | undefined> {
	let reply: AssistantMessage | undefined;
	let stopped = false;
	const unsubscribe = fork.subscribe((event) => {
		if (stopped || event.type !== "message_end" || event.message.role !== "assistant") return;
		// The last reply wins, so Pi's automatic retries after an error still count.
		reply = event.message as AssistantMessage;
		// A blocked tool call would start another turn; keep this reply and stop.
		if (reply.content.some((block) => block.type === "toolCall")) {
			stopped = true;
			void fork.abort();
		}
	});
	const onAbort = () => void fork.abort();
	signal.addEventListener("abort", onAbort);
	try {
		await fork.prompt(instruction, { expandPromptTemplates: false });
	} catch (error) {
		// Our own abort after a tool call ends the prompt; the reply already says what happened.
		if (!reply || signal.aborted) throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		unsubscribe();
	}
	return reply;
}

/**
 * Write the current branch (root to leaf, abandoned branches excluded) next to the session
 * file. Session discovery only scans one directory level, so the subdirectory is never
 * mistaken for a session. Returns the path, or undefined for sessions without a file.
 */
async function archiveBranch(ctx: ExtensionContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return undefined;
	const dir = `${sessionFile.replace(/\.jsonl$/, "")}.compact`;
	const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	await mkdir(dir, { recursive: true });
	await writeFile(path, ctx.sessionManager.getBranch().map((entry) => `${JSON.stringify(entry)}\n`).join(""), { flag: "wx" });
	return path;
}

/** Pi's file ops cover only what its own cut would summarize; nothing is kept here, so add the rest. */
function allFileOps(ctx: ExtensionContext, prepared: FileOps, firstKeptEntryId: string | undefined): FileOps {
	const fileOps: FileOps = { read: new Set(prepared.read), edited: new Set(prepared.edited), written: new Set(prepared.written) };
	const branch = ctx.sessionManager.getBranch();
	const start = branch.findIndex((entry) => entry.id === firstKeptEntryId);
	if (start < 0) return fileOps;
	for (const entry of branch.slice(start)) if (entry.type === "message") addFileOps(entry.message, fileOps);
	return fileOps;
}

function failureOf(reply: AssistantMessage | undefined): string | undefined {
	if (!reply) return "no reply";
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return reply.errorMessage || reply.stopReason;
	if (reply.stopReason === "length") return "summary hit the output limit";
	if (reply.content.some((block) => block.type === "toolCall")) return "the model called a tool";
	return undefined;
}

export function createCacheCompact(options: CacheCompactOptions = {}) {
	return function cacheCompact(pi: ExtensionAPI) {
		pi.on("session_before_compact", async (event, ctx) => {
			// Overflow means the conversation no longer fits; Pi's own summarizer sends less.
			if (event.reason === "overflow" || !ctx.model) return undefined;
			const expected = lastPromptTokens(ctx);
			let fork: AgentSession | undefined;
			let failure: string;
			try {
				fork = await createFork(ctx, pi.getActiveTools(), options);
				const reply = await summarize(fork, buildInstruction(event.customInstructions), event.signal);
				const text = reply?.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				failure = failureOf(reply) ?? (text ? "" : "empty summary");
				if (!failure && reply && text) {
					const usage = reply.usage;
					if (expected && usage.cacheRead < expected * MISS_RATIO) {
						ctx.ui.notify(`cache-compact: cache miss (${usage.cacheRead} of ~${expected} prompt tokens read from cache)`, "info");
					}
					const files = fileLists(allFileOps(ctx, event.preparation.fileOps, event.preparation.firstKeptEntryId));
					let notice = "";
					try {
						const archive = await archiveBranch(ctx);
						if (archive) notice = archiveNotice(archive);
					} catch (error) {
						ctx.ui.notify(`cache-compact: could not archive the conversation: ${error instanceof Error ? error.message : error}`, "warning");
					}
					return {
						compaction: {
							summary: text + files.text + notice,
							// Like Claude Code, the summary replaces the whole conversation: keeping Pi's
							// recent messages verbatim would duplicate what the summary already covers.
							// Pi stores null as a self-retaining compaction (keeps no earlier entries);
							// the hook's result type has not caught up with that.
							firstKeptEntryId: null as unknown as string,
							tokensBefore: event.preparation.tokensBefore,
							usage,
							details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
						},
					};
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				fork?.dispose();
			}
			if (!event.signal.aborted) ctx.ui.notify(`cache-compact: ${failure}; using Pi's default compaction`, "warning");
			return undefined;
		});
	};
}

export default createCacheCompact();
