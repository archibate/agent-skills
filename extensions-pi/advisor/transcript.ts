import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type TranscriptBlock = TextContent | ImageContent;
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** Render the effective context, never raw session entries or private reasoning. */
export function buildTranscript(messages: readonly AgentMessage[], instructions: string, maxBytes = MAX_TRANSCRIPT_BYTES): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	const calls = new Map<string, number>();
	let bytes = 0;
	function push(block: TranscriptBlock) {
		bytes += Buffer.byteLength(block.type === "text" ? block.text : block.data);
		if (bytes > maxBytes || blocks.length >= 40_000) {
			throw new Error("Advisor transcript exceeds the input limit; compact the main session before consulting again. Nothing was silently truncated.");
		}
		blocks.push(block);
	}
	function reference(id: string) {
		let number = calls.get(id);
		if (number === undefined) { number = calls.size + 1; calls.set(id, number); }
		return number;
	}
	function message(label: string, content: string | readonly TranscriptBlock[]) {
		let text = `[${label}]\n`;
		for (const block of typeof content === "string" ? [{ type: "text" as const, text: content }] : content) {
			if (block.type === "text") text += block.text;
			else {
				if (text) push({ type: "text", text });
				if (!block.data || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)) {
					throw new Error("Advisor transcript contains an unavailable or unsupported image; restore it in a supported format before consulting.");
				}
				push({ type: "image", data: block.data, mimeType: block.mimeType });
				text = "";
			}
		}
		if (text) push({ type: "text", text });
	}
	if (messages.length > 10_000) throw new Error("Too many messages for advisor; compact the main session first.");
	message("Main agent instructions — current", instructions);
	for (const m of messages) {
		switch (m.role) {
			case "system": break; // Current effective instructions above supersede historical prompt patches.
			case "user": message("User", m.content); break;
			case "assistant": {
				const parts: string[] = [];
				for (const b of m.content) {
					if (b.type === "text") parts.push(b.text);
					else if (b.type === "toolCall") parts.push(`[Tool call #${reference(b.id)}: ${b.name}]\n${JSON.stringify(b.arguments)}`);
				}
				if (parts.length) message("Main assistant", parts.join("\n"));
				break;
			}
			case "toolResult":
				message(`${m.toolName === "advisor" ? "Prior advisor result" : `Tool result: ${m.toolName}`} #${reference(m.toolCallId)}${m.isError ? " — error" : ""}`, m.content);
				break;
			case "compactionSummary": message("Compaction summary — not original evidence", m.summary); break;
			case "branchSummary": message("Branch summary — not original evidence", m.summary); break;
			case "custom": message(`Context: ${m.customType}`, m.content); break;
			case "bashExecution":
				if (!m.excludeFromContext) message("User shell execution", `${m.command}\n${m.output}\n[Exit: ${m.exitCode ?? "unknown"}${m.cancelled ? "; cancelled" : ""}${m.truncated ? "; output truncated" : ""}]${m.fullOutputPath ? `\nFull output: ${m.fullOutputPath}` : ""}`);
				break;
			default: throw new Error(`Advisor cannot serialize context role ${JSON.stringify((m as { role: string }).role)}; no request was sent.`);
		}
	}
	return blocks;
}
