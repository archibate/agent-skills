import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Extract raw user text, never model-generated summaries or context replacements. */
export function buildFreshPrompt(entries: readonly SessionEntry[]): {
	prompt: string;
	messageCount: number;
	omittedImages: number;
} {
	const messages: string[] = [];
	let omittedImages = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.flatMap((block) => {
				if (block.type === "image") omittedImages++;
				return block.type === "text" ? [block.text] : [];
			}).join("\n");
		if (text.trim()) messages.push(text);
	}
	return {
		prompt: messages.length === 0 ? "" : [
			"Reconsider these user messages from scratch, in chronological order. Later corrections supersede earlier requests. Assistant replies and tool output are deliberately omitted; verify the current state independently.",
			...messages.map((text, index) => `## User message ${index + 1}\n\n${text}`),
		].join("\n\n"),
		messageCount: messages.length,
		omittedImages,
	};
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("fresh", {
		description: "Choose where to restart this branch with a user-only prompt in the editor",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fresh", "warning");
				return;
			}
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/fresh requires the interactive terminal editor.", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the agent and queued messages to finish before /fresh.", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const draft = ctx.ui.getEditorText();
			// getBranch retains pre-compaction originals and excludes abandoned paths.
			const entries = ctx.sessionManager.getBranch();
			const starts = entries.flatMap((entry, index) => {
				if (entry.type !== "message" || entry.message.role !== "user") return [];
				const content = entry.message.content;
				const text = typeof content === "string" ? content
					: content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
				const preview = text.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
				return [{ id: entry.id, index, preview: preview ? preview.slice(0, 100) : "(no text)" }];
			});
			if (starts.length === 0) {
				ctx.ui.notify("No user text on the current branch.", "warning");
				return;
			}
			// The built-in selector highlights its first option by default.
			const options = starts.map((start, index) => `${index + 1}. ${start.preview}`);
			const choice = await ctx.ui.select("Fresh from which user message?", options);
			const start = starts[options.indexOf(choice ?? "")];
			if (!start) return;
			const unchanged = (): boolean => {
				if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId ||
					!ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify("Session changed; run /fresh again.", "warning");
					return false;
				}
				if (ctx.ui.getEditorText() !== draft) {
					ctx.ui.notify("Editor changed; run /fresh again. Draft kept.", "warning");
					return false;
				}
				return true;
			};
			if (!unchanged()) return;
			const { prompt, messageCount, omittedImages } = buildFreshPrompt(entries.slice(start.index));
			if (!prompt) {
				ctx.ui.notify(omittedImages
					? "No user text to extract. Image attachments cannot be copied as text."
					: "No user text on the current branch.", "warning");
				return;
			}
			if (draft.trim()) {
				if (!await ctx.ui.confirm("Replace editor draft?", "Copy or stash your draft first if you want to keep it.")) return;
				if (!unchanged()) return;
			}
			const target = entries[start.index];
			// Match Pi's contentText(..., "") when it restores the selected user text.
			const content = target.type === "message" && target.message.role === "user" ? target.message.content : "";
			const restoredText = typeof content === "string" ? content
				: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
			try {
				// Pi treats navigation to the current leaf as a no-op, even for a user
				// message. A context-free marker lets that case move before the user too.
				// On cancellation it stays on the old branch, without changing context.
				if (start.id === leafId) pi.appendEntry("fresh-navigation", {});
				const result = await ctx.navigateTree(start.id, { summarize: false });
				if (result.cancelled) return;
			} catch (error) {
				ctx.ui.notify(`Fresh navigation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			// Navigation awaits extension hooks with the editor active. Accept only
			// our original draft or Pi's own autofill; preserve anything newly typed.
			const editor = ctx.ui.getEditorText();
			if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== target.parentId ||
				!ctx.isIdle() || ctx.hasPendingMessages() ||
				(editor !== draft && (draft.trim() || editor !== restoredText))) {
				ctx.ui.notify("Session or editor changed during navigation; draft kept. Previous branch is in /tree.", "warning");
				return;
			}
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(
				`${messageCount} user message(s) ready to edit and send. Previous branch kept in /tree.` +
				(omittedImages ? ` ${omittedImages} image attachment(s) omitted; reattach them if needed.` : ""),
				omittedImages ? "warning" : "info",
			);
		},
	});
}
