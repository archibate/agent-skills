import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CostPublisher, observeAppends, REGISTRATION, registrationIn, type Registration } from "./accounting.ts";
import { CostLedger, publish, sessionPath } from "./ledger.ts";
import { installPresentation, SUMMARY } from "./presentation.ts";

export default function subagentCost(pi: ExtensionAPI): void {
	installPresentation();
	let release: (() => void) | undefined;
	let reconcile: (() => void) | undefined;
	let flush: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		release?.();
		let warned = false;
		const failed = (error: unknown) => {
			if (warned) return;
			warned = true;
			const message = `subagent-cost: ${error instanceof Error ? error.message : String(error)}. Totals may be stale; check storage and /reload.`;
			try {
				if (ctx.hasUI) {
					ctx.ui.setStatus("subagent-cost", "subagent cost unavailable/stale");
					ctx.ui.notify(message, "warning");
				} else console.error(message);
			} catch { /* A broken UI/stderr must not turn accounting into an agent failure. */ }
		};
		const safely = (action: () => void) => { try { action(); } catch (error) { failed(error); } };
		const manager = ctx.sessionManager;
		let ledger: CostLedger | undefined;
		let publisher: CostPublisher | undefined;
		let unobserve: (() => void) | undefined;
		let summary: ((refresh?: boolean) => { costUSD: number; count: number }) | undefined;
		release = () => {
			safely(() => publisher?.flush());
			unobserve?.();
			ledger?.close();
			if (Reflect.get(manager, SUMMARY) === summary) Reflect.deleteProperty(manager, SUMMARY);
			reconcile = undefined;
			flush = undefined;
			release = undefined;
		};
		const file = manager.getSessionFile();
		if (!file) return; // --no-session cannot supply persistent parent/child identities.
		try {
			const childFile = sessionPath(file);
			ledger = new CostLedger(childFile, () => {
				// setStatus requests a render even for an absent status. No extra footer label.
				if (ctx.mode === "tui") ctx.ui.setStatus("subagent-cost", warned ? "subagent cost unavailable/stale" : undefined);
			}, failed);
			summary = (refresh = false) => {
				if (refresh) ledger!.reconcile();
				return ledger!.summary();
			};
			Reflect.set(manager, SUMMARY, summary);
			reconcile = () => ledger!.reconcile();
			publisher = startPublisher(pi, ctx, childFile);
			if (publisher) {
				unobserve = observeAppends(manager, (entry) => {
					publisher!.add(entry);
					publisher!.flush();
				}, failed);
				flush = () => safely(() => publisher!.flush());
				flush();
			}
		} catch (error) { failed(error); }
	});
	pi.on("before_agent_start", () => { reconcile?.(); flush?.(); });
	pi.on("agent_settled", () => { flush?.(); });
	pi.on("session_shutdown", () => { release?.(); });
}

function startPublisher(pi: ExtensionAPI, ctx: ExtensionContext, childFile: string): CostPublisher | undefined {
	const entries = ctx.sessionManager.getEntries();
	const existing = registrationIn(entries, childFile);
	const inheritedParent = process.env.PI_SUBAGENT_PARENT_SESSION_FILE;
	if (!existing && !inheritedParent) return;
	const parent = sessionPath(existing?.registration.parentSessionFile ?? inheritedParent!);
	if (parent === childFile) return;
	// No post-append extension event covers cache warming/arbitrary usage in this host version.
	if (VERSION !== "1.0.4") throw new Error(`Append adapter supports Pi 1.0.4, found ${VERSION}; update subagent-cost`);
	const registration: Registration = existing?.registration ?? {
		childSessionFile: childFile,
		childSessionId: ctx.sessionManager.getSessionId(),
		parentSessionFile: parent,
	};
	if (!existing) {
		// This marker is the exact baseline: inherited fork history (including older markers)
		// and pre-install usage precede it. It is non-context state and survives compaction.
		pi.appendEntry(REGISTRATION, registration);
	}
	const publisher = new CostPublisher(registration, publish);
	if (existing) for (let i = existing.index + 1; i < entries.length; i++) publisher.add(entries[i]!);
	return publisher;
}
