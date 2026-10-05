/**
 * Review of tool calls that need access beyond the allowance (permissions.ts).
 *
 * A Reviewer turns a ReviewRequest into a Verdict. `deny` refuses without asking, for headless
 * runs; `manual` asks the user in a modal (modal.ts). `auto` and `auto-manual` are reserved for a
 * reviewer model and are not implemented yet.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ReviewModal } from "./modal.ts";

export const REVIEWER_FLAG = "reviewer";
export const REVIEWER_NAMES = ["deny", "manual", "auto", "auto-manual"] as const;
export type ReviewerName = (typeof REVIEWER_NAMES)[number];

export interface ReviewRequest {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	/** What is being asked for, e.g. "bash". */
	subject: string;
	/** Grants beyond the allowance. */
	excess: string[];
	/** Description of what "always" would add; absent when it cannot be pre-approved. */
	always?: string;
}

export type Verdict = { kind: "approve" } | { kind: "always" } | { kind: "deny"; feedback?: string };

export interface Reviewer {
	readonly name: ReviewerName;
	review(request: ReviewRequest, ctx: ExtensionContext): Promise<Verdict>;
}

const denyReviewer: Reviewer = {
	name: "deny",
	review: async () => ({ kind: "deny" }),
};

const manualReviewer: Reviewer = {
	name: "manual",
	async review(request, ctx) {
		if (ctx.mode !== "tui") return { kind: "deny" };
		const signal = ctx.signal;
		if (signal?.aborted) return { kind: "deny" };
		const choice = await ctx.ui.custom<Verdict | "feedback">((tui, theme, _keybindings, done) => {
			const onAbort = () => done({ kind: "deny" });
			signal?.addEventListener("abort", onAbort, { once: true });
			const modal = new ReviewModal(tui, theme, request, (verdict) => {
				signal?.removeEventListener("abort", onAbort);
				done(verdict);
			});
			return modal;
		});
		if (choice !== "feedback") return choice;
		const feedback = await ctx.ui.input("Feedback for the agent", "why it was denied, or what to do instead");
		return { kind: "deny", feedback: feedback?.trim() || undefined };
	},
};

/** The reviewer for `name` in `mode`; throws for reviewers this mode or build cannot run. */
export function createReviewer(name: string, mode: ExtensionContext["mode"]): Reviewer {
	if (name === "deny") return denyReviewer;
	if (name === "manual") {
		if (mode !== "tui") throw new Error(`--${REVIEWER_FLAG} manual needs the interactive TUI; use deny`);
		return manualReviewer;
	}
	if (name === "auto" || name === "auto-manual") {
		throw new Error(`--${REVIEWER_FLAG} ${name} is not available yet; use deny or manual`);
	}
	throw new Error(`--${REVIEWER_FLAG} must be one of ${REVIEWER_NAMES.join(", ")}; got ${JSON.stringify(name)}`);
}

/** The default reviewer: ask in the TUI, refuse elsewhere. */
export function defaultReviewerName(mode: ExtensionContext["mode"]): ReviewerName {
	return mode === "tui" ? "manual" : "deny";
}

/** The tool error the agent sees for a denied call. */
export function denialReason(request: ReviewRequest, verdict: Verdict, reviewer: ReviewerName, permissions: string): string {
	const needs = `${request.subject} needs ${request.excess.join("; ")}`;
	if (reviewer === "deny") {
		return `Blocked: ${needs}, beyond this run's permissions (${permissions}). Stay within them, or report what you need instead.`;
	}
	const feedback = verdict.kind === "deny" && verdict.feedback ? ` Feedback: ${verdict.feedback}` : "";
	return `The user denied this call: ${needs}.${feedback} Do not retry it as is; find another way or ask the user.`;
}
