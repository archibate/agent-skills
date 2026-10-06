import type { Reviewer, Verdict } from "./review.ts";
import { ReviewModal } from "./modal.ts";

export function createManualReviewer(): Reviewer {
	return {
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
}
