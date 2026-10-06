/**
 * Review marks under reviewed tool calls: "✓ approved", "✓ always", "✗ denied". The marks are
 * kept in session entries, so a resumed transcript still shows which calls were reviewed.
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

export type ReviewMark = "approved" | "always" | "denied" | "auto-approved" | "auto-denied";
export function isReviewMark(value: unknown): value is ReviewMark {
	return typeof value === "string" && ["approved", "always", "denied", "auto-approved", "auto-denied"].includes(value);
}
export const MARK_ENTRY = "sandbox-review";

const MARKED_TOOLS = new Set(["bash", "job_start", "write", "edit"]);

function markText(mark: ReviewMark, theme: Pick<Theme, "fg">): string {
	if (mark === "auto-approved") return theme.fg("success", "✓ auto approved");
	if (mark === "auto-denied") return theme.fg("error", "✗ auto denied");
	if (mark === "denied") return theme.fg("error", "✗ denied");
	return theme.fg("success", mark === "always" ? "✓ always (added to session permissions)" : "✓ approved");
}

/** The tool's own call component with a mark line below it. */
class MarkedCall implements Component {
	inner: Component | undefined;
	mark: string | undefined;

	render(width: number): string[] {
		const lines = this.inner?.render(width) ?? [];
		return this.mark ? [...lines, truncateToWidth(this.mark, width)] : lines;
	}

	invalidate(): void {
		this.inner?.invalidate();
	}
}

/** Wrap the call renderers of reviewed tools so each reviewed call shows its mark. */
export function registerReviewMarks(pi: ExtensionAPI, markOf: (toolCallId: string) => ReviewMark | undefined): void {
	pi.registerToolRenderer((toolName, next): ToolRenderers | undefined => {
		const base = next();
		if (!MARKED_TOOLS.has(toolName) || !base?.renderCall) return base;
		const renderCall = base.renderCall;
		return {
			...base,
			renderCall(args, theme, context) {
				const box = context.lastComponent instanceof MarkedCall ? context.lastComponent : new MarkedCall();
				box.inner = renderCall(args, theme, { ...context, lastComponent: box.inner });
				const mark = markOf(context.toolCallId);
				box.mark = mark ? markText(mark, theme) : undefined;
				return box;
			},
		};
	});
}
