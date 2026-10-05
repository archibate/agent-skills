/**
 * /plan - a hint-only "plan mode".
 *
 * While on, it re-injects a short [PLAN MODE ACTIVE] reminder before each turn
 * telling the model to investigate and discuss a plan instead of executing it,
 * and to keep the repo/system read-only (scratchpad excepted).
 *
 * Deliberately does NOT swap the tool set, track todos, or grep bash commands:
 * those are what make the upstream example extension expensive. That also keeps
 * the prompt-prefix cache intact - the hint is only appended after the latest
 * turn, and the one-time removal on exit is the only splice.
 *
 * Exit is an explicit user toggle (/plan or Ctrl+Alt+P): the model cannot exit
 * itself, and presenting a plan does not end the mode. Toggling off queues a
 * one-shot [PLAN MODE OFF] notice on the next turn, so the model gets a positive
 * "you may now mutate" cue instead of only losing the restriction.
 *
 * Toggle: /plan, Ctrl+Alt+P, or start with --plan. `/plan <prompt>` enables plan
 * mode and sends the prompt in one step. Status shows "⏸ plan".
 * This is guidance, not enforcement - the model can still ignore it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const HINT = `[PLAN MODE ACTIVE]
Read-only planning mode. Investigate as needed, then present a plan for the request and discuss it with the user before executing anything.
Do not edit files or run commands that mutate system state. The session scratchpad is the only writable place, for analytical temporaries.`;

const EXIT_HINT = `[PLAN MODE OFF]
Plan mode has ended. You may now make changes: edit files, run mutating commands, and execute the approved plan.`;

export default function (pi: ExtensionAPI): void {
	let enabled = false;
	let exitPending = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("plan-mode", enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
	}

	function setEnabled(ctx: ExtensionContext, value: boolean): void {
		if (enabled === value) return;
		enabled = value;
		if (!enabled) exitPending = true;
		updateStatus(ctx);
		ctx.ui.notify(enabled ? "Plan mode on — planning only, no edits." : "Plan mode off — changes allowed.");
	}

	function toggle(ctx: ExtensionContext): void {
		setEnabled(ctx, !enabled);
	}

	pi.registerFlag("plan", { description: "Start in plan mode (read-only planning hint)", type: "boolean", default: false });

	pi.registerCommand("plan", {
		description: "Toggle plan mode; with a prompt, enable and send it",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				toggle(ctx);
				return;
			}
			// `/plan <prompt>` turns plan mode on (idempotent, never off) and
			// feeds the prompt to the agent as if typed.
			setEnabled(ctx, true);
			pi.sendUserMessage(prompt, ctx.isIdle() ? {} : { deliverAs: "followUp" });
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => toggle(ctx),
	});

	// Keep the two hints from contradicting each other: drop stale [PLAN MODE
	// ACTIVE] reminders once off, and any leftover [PLAN MODE OFF] notice once
	// planning resumes.
	pi.on("context", async (event) => {
		const drop = enabled ? "plan-mode-exit" : "plan-mode-hint";
		return {
			messages: event.messages.filter((m) => (m as { customType?: string }).customType !== drop),
		};
	});

	// Append the hint before each turn while on. Appending (never splicing
	// history) keeps the cached prefix reusable and keeps the reminder recent.
	pi.on("before_agent_start", async () => {
		if (enabled) return { message: { customType: "plan-mode-hint", content: HINT, display: false } };
		if (exitPending) {
			exitPending = false;
			return { message: { customType: "plan-mode-exit", content: EXIT_HINT, display: false } };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) enabled = true;
		updateStatus(ctx);
	});
}
