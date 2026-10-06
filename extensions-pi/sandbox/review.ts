/**
 * Review of tool calls that need access beyond the allowance (permissions.ts).
 *
 * A Reviewer turns a ReviewRequest into a Verdict. `deny` refuses without asking, for headless
 * runs; `manual` asks the user in a modal (modal.ts). `auto` uses a read-only reviewer model;
 * `auto-manual` escalates its denials/failures to the human (auto-review.ts).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoReviewerOptions } from "./auto-review.ts";
import { lazyReviewer } from "./lazy-reviewer.ts";
import { DEFAULT_REVIEWER_MODEL, validateReviewerModel } from "./review-config.ts";
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

function createAutomaticReviewer(options: AutoReviewerOptions): Reviewer {
	const selected = { ...options, model: options.model ?? DEFAULT_REVIEWER_MODEL };
	validateReviewerModel(selected.model);
	return lazyReviewer("auto", async () => {
		const { AutoReviewer } = await import("./auto-review.ts");
		return () => new AutoReviewer(selected);
	});
}

function createManualReviewer(): Reviewer {
	return lazyReviewer("manual", async () => {
		const module = await import("./manual-review.ts");
		return module.createManualReviewer;
	});
}

/** Selection and configuration validation are synchronous; implementations load on first review. */
export function createReviewer(name: string, mode: ExtensionContext["mode"], options: AutoReviewerOptions = {}): Reviewer {
	if (name === "deny") return denyReviewer;
	if (name === "manual") {
		if (mode !== "tui") throw new Error(`--${REVIEWER_FLAG} manual needs the interactive TUI; use deny`);
		return createManualReviewer();
	}
	if (name === "auto") return createAutomaticReviewer(options);
	if (name === "auto-manual") {
		if (mode !== "tui") throw new Error(`--${REVIEWER_FLAG} auto-manual needs the interactive TUI; use auto or deny`);
		const auto = createAutomaticReviewer(options);
		const manual = createManualReviewer();
		let epoch = 0;
		let disposed = false;
		return {
			name: "auto-manual",
			reset() { epoch++; auto.reset?.(); manual.reset?.(); },
			dispose() { disposed = true; epoch++; auto.dispose?.(); manual.dispose?.(); },
			async review(request, ctx) {
				const current = epoch;
				const cancelled = () => disposed || current !== epoch || ctx.signal?.aborted;
				const cancellation: Verdict = { kind: "deny", cancelled: true, feedback: "Review cancelled" };
				if (cancelled()) return cancellation;
				const verdict = await auto.review(request, ctx);
				if (cancelled()) return cancellation;
				if (verdict.kind !== "deny" || verdict.cancelled) return verdict;
				const answer = await manual.review({ ...request, reviewerFeedback: verdict.feedback }, ctx);
				if (cancelled()) return cancellation;
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
