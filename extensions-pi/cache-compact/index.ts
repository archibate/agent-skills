import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildInstruction, fileLists, isWarmReplay, splicePayload, SUPPORTED_APIS, tailMessages } from "./compaction.ts";

/** Fallback cache lifetime for models that do not declare one (OpenAI keeps prefixes at least this long). */
const DEFAULT_CACHE_TTL_SECONDS = 300;
/** Treat the cache as cold slightly before it expires, like Pi's cache warmer. */
const FRESHNESS_FRACTION = 0.9;

interface Capture {
	payload: unknown;
	provider: string;
	modelId: string;
	sessionId: string;
	leafId: string | null;
	sentAt: number;
}

export interface CacheCompactOptions {
	now?: () => number;
}

function cacheWindowMs(model: Model<Api>): number {
	const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const seconds = model.promptCache?.[retention] ?? DEFAULT_CACHE_TTL_SECONDS;
	return seconds * 1000 * FRESHNESS_FRACTION;
}

export function createCacheCompact(options: CacheCompactOptions = {}) {
	const now = options.now ?? Date.now;
	return function cacheCompact(pi: ExtensionAPI) {
		let last: Capture | undefined;
		let compacting = false;

		pi.on("session_start", () => {
			last = undefined;
		});
		pi.on("session_compact", () => {
			last = undefined;
		});

		pi.on("before_provider_request", (event, ctx) => {
			const model = ctx.model;
			if (compacting || !model || !SUPPORTED_APIS.has(model.api)) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			if (isWarmReplay(event.payload)) {
				// A warming replay refreshes the cache of the captured request without changing it.
				if (last && last.provider === model.provider && last.modelId === model.id && last.sessionId === sessionId && last.leafId === leafId) {
					last.sentAt = now();
				}
				return undefined;
			}
			last = { payload: structuredClone(event.payload), provider: model.provider, modelId: model.id, sessionId, leafId, sentAt: now() };
			return undefined;
		});

		pi.on("session_before_compact", async (event, ctx) => {
			const capture = last;
			const model = ctx.model;
			// Overflow means the captured request no longer fits; Pi's own summarizer sends less.
			if (event.reason === "overflow" || !capture || !model) return undefined;
			if (capture.provider !== model.provider || capture.modelId !== model.id) return undefined;
			if (capture.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
			if (now() - capture.sentAt > cacheWindowMs(model)) return undefined;
			const tail = tailMessages(event.branchEntries, capture.leafId);
			if (!tail) return undefined;

			const instruction = {
				role: "user" as const,
				content: [{ type: "text" as const, text: buildInstruction(event.customInstructions) }],
				timestamp: now(),
			};
			const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
			let failure: string | undefined;
			compacting = true;
			try {
				const response = await ctx.modelRegistry
					.streamSimple(model, { messages: convertToLlm([...tail, instruction]) }, {
						sessionId: capture.sessionId,
						signal: event.signal,
						cacheRetention: "short",
						...(model.reasoning && thinking && thinking !== "off" ? { reasoning: thinking } : {}),
						onPayload: (built: unknown) => {
							const spliced = splicePayload(model.api, capture.payload, built);
							if (!spliced) throw new Error("unexpected request shape");
							return spliced;
						},
					})
					.result();
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					failure = response.errorMessage || response.stopReason;
				} else if (response.stopReason === "length") {
					failure = "summary hit the output limit";
				} else if (response.content.some((block) => block.type === "toolCall")) {
					failure = "the model called a tool";
				} else {
					const text = response.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("\n")
						.trim();
					if (!text) {
						failure = "empty summary";
					} else {
						const files = fileLists(event.preparation.fileOps);
						return {
							compaction: {
								summary: text + files.text,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								usage: response.usage,
								details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
							},
						};
					}
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				compacting = false;
			}
			if (!event.signal.aborted) ctx.ui.notify(`cache-compact: ${failure}; using Pi's default compaction`, "warning");
			return undefined;
		});
	};
}

export default createCacheCompact();
