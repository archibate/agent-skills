/**
 * Review of tool calls that need access beyond the allowance (permissions.ts).
 *
 * A Reviewer turns a ReviewRequest into a Verdict. `deny` refuses without asking, for headless
 * runs; `manual` asks the user in a modal (modal.ts). `auto` uses a read-only reviewer model;
 * `auto-manual` escalates its denials/failures to the human (auto-review.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutoReviewer, type AutoReviewerOptions } from "./auto-review.ts";
import { ReviewModal } from "./modal.ts";
import type { SandboxPolicy } from "./policy.ts";

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
	toolCallId?: string;
	permissions?: string;
	toolDescription?: string;
	resolvedPath?: string;
	resolvedAccess?: SandboxPolicy;
	/** Automatic denial/failure shown when escalating to the human. */
	reviewerFeedback?: string;
}

export type Verdict = ({ kind: "approve"; reason?: string } | { kind: "always" } | { kind: "deny"; feedback?: string; cancelled?: boolean }) & { source?: "auto" | "manual" };

export interface Reviewer {
	readonly name: ReviewerName;
	review(request: ReviewRequest, ctx: ExtensionContext): Promise<Verdict>;
	reset?(): void;
	dispose?(): void;
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
			let modal: ReviewModal;
			const finish = (verdict: Verdict | "feedback") => {
				signal?.removeEventListener("abort", onAbort);
				modal?.dispose();
				done(verdict);
			};
			const onAbort = () => finish({ kind: "deny", cancelled: true });
			modal = new ReviewModal(tui, theme, request, finish);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			return modal;
		});
		if (signal?.aborted) return { kind: "deny", cancelled: true };
		if (choice !== "feedback") return choice;
		const feedback = await ctx.ui.input("Feedback for the agent", "why it was denied, or what to do instead", { signal });
		return { kind: "deny", feedback: signal?.aborted ? undefined : feedback?.trim() || undefined, ...(signal?.aborted ? { cancelled: true } : {}) };
	},
};

/** The reviewer for `name` in `mode`; throws for reviewers this mode or build cannot run. */
export function createReviewer(name: string, mode: ExtensionContext["mode"], options: AutoReviewerOptions = {}): Reviewer {
	if (name === "deny") return denyReviewer;
	if (name === "manual") {
		if (mode !== "tui") throw new Error(`--${REVIEWER_FLAG} manual needs the interactive TUI; use deny`);
		return manualReviewer;
	}
	if (name === "auto") return new AutoReviewer(options);
	if (name === "auto-manual") {
		if (mode !== "tui") throw new Error(`--${REVIEWER_FLAG} auto-manual needs the interactive TUI; use auto or deny`);
		const auto = new AutoReviewer(options);
		return {
			name: "auto-manual",
			reset: () => auto.reset(),
			dispose: () => auto.dispose(),
			async review(request, ctx) {
				const verdict = await auto.review(request, ctx);
				if (verdict.kind !== "deny" || verdict.cancelled || ctx.signal?.aborted) return verdict;
				const answer = await manualReviewer.review({ ...request, reviewerFeedback: verdict.feedback }, ctx);
				return { ...answer, source: "manual", ...(answer.kind === "deny" && !answer.cancelled && !answer.feedback ? { feedback: `Automatic review: ${verdict.feedback}` } : {}) };
			},
		};
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
	const origin = verdict.kind === "deny" && verdict.cancelled ? "Review cancelled" : verdict.source === "auto" ? "Blocked by automatic review" : "The user denied this call";
	return `${origin}: ${needs}.${feedback} Do not retry it as is; find another way or ask the user.`;
}
