import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readPolicy, savePairing } from "./pairings.ts";
import { AdvisorPicker, type AdvisorChoice } from "./picker.ts";

interface CommandState {
	path: string;
	current(): string | undefined;
	generation(): number;
	sessionGeneration(): number;
	apply(model: string | null, ctx: ExtensionCommandContext): string | undefined;
}

export function registerAdvisorCommand(pi: ExtensionAPI, state: CommandState): void {
	pi.registerCommand("advisor", {
		description: "Choose an advisor for this session; Ctrl+S also saves the current main-model pairing",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/advisor requires the interactive terminal picker. Use --advisor provider/model or --advisor none at launch.", "warning"); return; }
			if (!ctx.model) { ctx.ui.notify("Select a main model first.", "warning"); return; }
			if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Wait for the agent and queued messages to finish before /advisor.", "warning"); return; }
			const main = `${ctx.model.provider}/${ctx.model.id}`;
			const sessionId = ctx.sessionManager.getSessionId();
			const generation = state.generation();
			const sessionGeneration = state.sessionGeneration();
			const models = ctx.modelRegistry.getAvailable().filter((model) => model.api !== "pi-virtual");
			let saved: string | null | undefined;
			try { saved = readPolicy(undefined, state.path).pairings.get(main); }
			catch { ctx.ui.notify("Saved advisor pairings could not be read. Enter can still select for this session; saving will report the configuration error.", "warning"); }
			const choice = await ctx.ui.custom<AdvisorChoice | undefined>((tui, theme, keys, done) =>
				new AdvisorPicker(tui, theme, keys, done, { main, models, current: state.current(), saved, query: args.trim() }));
			if (!choice || state.sessionGeneration() !== sessionGeneration) return; // Old ctx is invalid after reload/replacement.
			if (state.generation() !== generation || ctx.sessionManager.getSessionId() !== sessionId ||
				!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== main || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Session or main model changed; run /advisor again. Nothing was changed.", "warning"); return;
			}
			let persisted = false;
			try {
				if (choice.model !== null && !models.some((model) => `${model.provider}/${model.id}` === choice.model)) throw new Error("The selected advisor is not an available physical model.");
				let warning: string | undefined;
				if (choice.save) { warning = savePairing(state.path, main, choice.model); persisted = true; }
				warning = [warning, state.apply(choice.model, ctx)].filter(Boolean).join(" ") || undefined;
				const message = persisted ? `Advisor ${choice.model ?? "none"}; saved pairing for ${main}.` : `Advisor ${choice.model ?? "none"} for this session (pairings unchanged).`;
				ctx.ui.notify(warning ? `${message} ${warning}` : message, warning ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`${persisted ? "Pairing saved, but session selection failed" : "Advisor selection failed"}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
