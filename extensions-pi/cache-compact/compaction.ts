import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

type AgentMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

/** Provider request formats whose message list can be extended in place. */
export const SUPPORTED_APIS = new Set(["anthropic-messages", "openai-responses"]);

/** Entry types that add nothing to the model context after the captured request. */
const IGNORED_ENTRY_TYPES = new Set(["custom", "label", "session_info", "usage"]);
/** Entry types whose messages can follow the captured request verbatim. */
const CONTEXT_ENTRY_TYPES = new Set(["message", "custom_message"]);

const SUMMARY_FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** The user message appended to the cached conversation to request the summary. */
export function buildInstruction(customInstructions?: string): string {
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `[Context compaction] This message comes from the agent harness, not from the user. It is not part of the conversation: leave it out of the summary.

Stop the current task. Do not call tools, do not continue the conversation, and do not answer questions from it. Create a structured context checkpoint summary of the entire conversation above that another LLM will use to continue the work. If the conversation starts with an earlier compaction summary, preserve its information and update it with everything that happened since. Output ONLY the summary.

${SUMMARY_FORMAT}${focus}`;
}

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (!isRecord(value)) return value;
	const result: Payload = {};
	for (const [key, child] of Object.entries(value)) {
		if (key !== "cache_control") result[key] = withoutCacheControl(child);
	}
	return result;
}

/** Pi's warming replays resend the last request with a one-token output cap. */
export function isWarmReplay(payload: unknown): boolean {
	return isRecord(payload) && (payload.max_tokens === 1 || payload.max_output_tokens === 1);
}

/**
 * Append the messages of a freshly built request to a captured request, so the
 * captured prefix (tools, system prompt, messages, settings) stays byte-identical.
 * Returns undefined when either payload has an unexpected shape.
 */
export function splicePayload(api: string, captured: unknown, built: unknown): Payload | undefined {
	if (!isRecord(captured) || !isRecord(built)) return undefined;
	if (api === "anthropic-messages") {
		if (!Array.isArray(captured.messages) || !Array.isArray(built.messages)) return undefined;
		const tail = [...built.messages];
		// Leading effort markers restate the level already closing the captured request.
		while (isRecord(tail[0]) && tail[0].role === "system" && Array.isArray(tail[0].content) && tail[0].content.length === 0) tail.shift();
		// The captured breakpoints already cover the prefix; extra ones could exceed Anthropic's limit of four.
		return { ...captured, messages: [...captured.messages, ...(withoutCacheControl(tail) as unknown[])] };
	}
	if (api === "openai-responses") {
		if (!Array.isArray(captured.input) || !Array.isArray(built.input)) return undefined;
		const tail = [...built.input];
		while (isRecord(tail[0]) && (tail[0].role === "system" || tail[0].role === "developer")) tail.shift();
		// Unsigned replies get position-based ids; positions restart in the built request, so keep them distinct.
		const renamed = tail.map((item) => isRecord(item) && typeof item.id === "string" && /^msg_pi_\d+(_\d+)?$/.test(item.id)
			? { ...item, id: `${item.id}_tail` } : item);
		return { ...captured, input: [...captured.input, ...renamed] };
	}
	return undefined;
}

/**
 * Context messages added to the branch after `leafId`, the leaf when the captured
 * request was sent. Undefined when the leaf is gone or a later entry changed the
 * model, settings, or earlier context, any of which would break the cached prefix.
 */
export function tailMessages(branchEntries: readonly SessionEntry[], leafId: string | null): AgentMessage[] | undefined {
	if (!leafId) return undefined;
	const index = branchEntries.findIndex((entry) => entry.id === leafId);
	if (index < 0) return undefined;
	const messages: AgentMessage[] = [];
	for (const entry of branchEntries.slice(index + 1)) {
		if (CONTEXT_ENTRY_TYPES.has(entry.type)) messages.push(...sessionEntryToContextMessages(entry));
		else if (!IGNORED_ENTRY_TYPES.has(entry.type)) return undefined;
	}
	return messages;
}

/** Same file lists and format as Pi's default compaction. */
export function fileLists(fileOps: { read: Set<string>; edited: Set<string>; written: Set<string> }) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return { readFiles, modifiedFiles, text: sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "" };
}
