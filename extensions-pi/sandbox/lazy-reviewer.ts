import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reviewer, ReviewRequest, Verdict } from "./review.ts";

type Implementation = () => Reviewer;

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
export function lazyReviewer(name: "auto" | "manual", load: () => Promise<Implementation>): Reviewer {
	let factory: Promise<Implementation> | undefined;
	let implementation: Reviewer | undefined;
	let invalidation = new AbortController();
	let disposed = false;
	const cancelled = (): Verdict => ({ kind: "deny", ...(name === "auto" ? { source: "auto" as const } : {}), cancelled: true, feedback: "Review cancelled" });
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
			try {
				factory ??= Promise.resolve().then(load);
				const create = await untilAborted(factory, signal);
				if (disposed || signal.aborted) return cancelled();
				implementation ??= create();
				const context: ExtensionContext = Object.create(ctx);
				Object.defineProperty(context, "signal", { value: signal });
				const verdict = await untilAborted(implementation.review(request, context), signal);
				return disposed || signal.aborted ? cancelled() : verdict;
			} catch {
				if (disposed || signal.aborted) return cancelled();
				return {
					kind: "deny", ...(name === "auto" ? { source: "auto" as const } : {}),
					feedback: `${name === "auto" ? "Automatic" : "Manual"} review unavailable: reviewer implementation failed.`,
				};
			}
		},
	};
}
