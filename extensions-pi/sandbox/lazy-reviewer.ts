import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reviewer, ReviewRequest, Verdict } from "./review.ts";
import { REVIEW_LIMITS } from "./review-config.ts";

type Implementation = () => Reviewer;
export type ReviewFailurePhase = "load" | "construct" | "review";
interface LazyReviewerOptions {
	timeoutMs?: number;
	/** Returning false prevents escalation when the failure could not be audited. */
	onFailure?: (failure: { toolCallId?: string; phase: ReviewFailurePhase; feedback: string; elapsedMs: number }) => void | false;
}
class LoadingTimeout extends Error {}

/** Cache the bounded promise, so even a hung import cannot accumulate waiters indefinitely. */
function loadWithinDeadline(load: () => Promise<Implementation>, timeoutMs: number): Promise<Implementation> {
	let timer: ReturnType<typeof setTimeout>;
	return new Promise<Implementation>((resolve, reject) => {
		timer = setTimeout(() => reject(new LoadingTimeout()), timeoutMs);
		timer.unref();
		Promise.resolve().then(load).then(resolve, reject);
	}).finally(() => clearTimeout(timer));
}

/** An import cannot be aborted, but its late completion must not start a cancelled review. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: () => void;
	return new Promise<T>((resolve, reject) => {
		abort = () => reject(new Error("Review cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject);
		if (signal.aborted) abort();
	}).finally(() => signal.removeEventListener("abort", abort));
}

/** Keep registration synchronous and reuse one implementation once a review actually needs it. */
export function lazyReviewer(name: "auto" | "manual", load: () => Promise<Implementation>, options: LazyReviewerOptions = {}): Reviewer {
	let factory: Promise<Implementation> | undefined;
	let implementation: Reviewer | undefined;
	let invalidation = new AbortController();
	let disposed = false;
	const cancelled = (): Extract<Verdict, { kind: "deny" }> => ({ kind: "deny", ...(name === "auto" ? { source: "auto" as const } : {}), cancelled: true, feedback: "Review cancelled" });
	return {
		name,
		reset() {
			if (disposed) return;
			invalidation.abort();
			invalidation = new AbortController();
			implementation?.reset?.();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			invalidation.abort();
			implementation?.dispose?.();
		},
		async review(request: ReviewRequest, ctx: ExtensionContext): Promise<Verdict> {
			const signal = AbortSignal.any([invalidation.signal, ...(ctx.signal ? [ctx.signal] : [])]);
			if (disposed || signal.aborted) return cancelled();
			const started = performance.now();
			let phase: ReviewFailurePhase = "load";
			try {
				factory ??= loadWithinDeadline(load, options.timeoutMs ?? REVIEW_LIMITS.timeoutMs);
				const create = await untilAborted(factory, signal);
				if (disposed || signal.aborted) return cancelled();
				phase = "construct";
				implementation ??= create();
				const context: ExtensionContext = Object.create(ctx);
				Object.defineProperty(context, "signal", { value: signal });
				phase = "review";
				const verdict = await untilAborted(implementation.review(request, context), signal);
				return disposed || signal.aborted ? cancelled() : verdict;
			} catch (error) {
				if (disposed || signal.aborted) return cancelled();
				const cause = error instanceof LoadingTimeout ? "reviewer module loading timed out" :
					phase === "load" ? "reviewer module could not be loaded" :
					phase === "construct" ? "reviewer could not be initialized" : "reviewer implementation failed";
				const feedback = `${name === "auto" ? "Automatic" : "Manual"} review unavailable: ${cause}.`;
				let auditFailed = false;
				try {
					auditFailed = options.onFailure?.({ toolCallId: request.toolCallId, phase, feedback, elapsedMs: Math.round(performance.now() - started) }) === false;
				} catch { auditFailed = true; }
				// Do not escalate an unauditable failure to a human approval.
				if (auditFailed) return { ...cancelled(), feedback: "Review cancelled: reviewer failure audit could not be recorded." };
				return { kind: "deny", ...(name === "auto" ? { source: "auto" as const } : {}), feedback };
			}
		},
	};
}
