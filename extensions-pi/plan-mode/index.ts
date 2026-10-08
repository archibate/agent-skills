/** Stable tool declarations; branch-relative planning state and append-only model notices. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CHECKPOINT_ENTRY, OFF_NOTICE, STATE_ENTRY, createPlan, executionHandoff, planningNotice, readPlan, restorePlan,
	type Plan, type PlanSnapshot,
} from "./store.ts";
import { APPROVAL_CHOICES, askQuestions, renderPlanResult, renderTextResult, toolResult } from "./ui.ts";
import { planningSandbox } from "./sandbox-link.ts";

interface Handoff {
	token: string;
	sessionId: string;
	revision: number;
	plan: Plan;
	snapshot: PlanSnapshot;
	toolCallId: string;
	signal?: AbortSignal;
	approvalEntryId?: string;
	dispatched?: boolean;
}

function requireSoloCall(ctx: ExtensionContext, toolCallId: string): void {
	const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (entry?.type !== "message" || entry.message.role !== "assistant") throw new Error("Call this tool alone in an assistant tool-call turn");
	const calls = entry.message.content.filter((part) => part.type === "toolCall");
	if (calls.length !== 1 || calls[0].id !== toolCallId) throw new Error("Call this tool alone, without sibling tool calls");
}

export default function planMode(pi: ExtensionAPI): void {
	let plan: Plan | undefined;
	let failure: string | undefined;
	let revision = 0;
	let interaction: AbortController | undefined;
	let requestedMode: boolean | undefined;
	let handoff: Handoff | undefined;
	let navigating: string | undefined;
	const sandbox = planningSandbox(pi);
	let sandboxFailure: string | undefined;

	function invalidate(): void {
		revision++;
		interaction?.abort();
		interaction = undefined;
		handoff = undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		try {
			sandbox.update(!!(plan || failure), plan?.path);
			sandboxFailure = undefined;
		} catch (error) {
			const message = `Planning sandbox failed: ${error instanceof Error ? error.message : String(error)}`;
			if (message !== sandboxFailure) ctx.ui.notify(message, "error");
			sandboxFailure = message;
		}
		if (!ctx.hasUI) return;
		const label = plan || failure ? "⏸ plan" : undefined;
		ctx.ui.setStatus("plan-mode", label && ctx.mode === "tui" ? ctx.ui.theme.fg("warning", label) : label);
	}

	function save(ctx: ExtensionContext): void {
		pi.appendEntry(STATE_ENTRY, { version: 1, plan: plan ?? null });
		updateStatus(ctx);
	}

	function checkpoint(ctx: ExtensionContext): void {
		if (!plan || plan.checkpointId) return;
		pi.appendEntry(CHECKPOINT_ENTRY, { planId: plan.id });
		const id = ctx.sessionManager.getLeafId();
		if (!id) throw new Error("Could not save the planning checkpoint");
		plan = { ...plan, checkpointId: id };
		save(ctx);
	}

	function enter(ctx: ExtensionContext, deferCheckpoint: boolean): Plan {
		if (failure) throw new Error(failure);
		if (plan) return plan;
		invalidate();
		try { plan = createPlan(ctx.sessionManager.getSessionId()); }
		catch (error) {
			failure = `Could not enter planning: ${error instanceof Error ? error.message : String(error)}. Fix storage, then use /plan off to reset and /plan on to retry.`;
			updateStatus(ctx);
			pi.appendEntry(STATE_ENTRY, { version: 1, plan: null, failure });
			throw new Error(failure, { cause: error });
		}
		save(ctx);
		// A tool-driven entry is bookmarked only after its entire call/result pair is persisted.
		if (!deferCheckpoint) checkpoint(ctx);
		return plan;
	}

	function manualMode(ctx: ExtensionContext, enabled: boolean): void {
		if (!!plan === enabled && !failure) return;
		if (enabled) enter(ctx, false);
		else {
			invalidate();
			plan = undefined;
			failure = undefined;
			save(ctx);
		}
		pi.sendMessage({ customType: "plan-mode-notice", content: plan ? planningNotice(plan) : OFF_NOTICE, display: false }, { triggerTurn: false });
		ctx.ui.notify(plan ? `Planning · ${plan.path}` : "Plan mode off — changes allowed.");
	}

	function restore(ctx: ExtensionContext): void {
		try {
			plan = restorePlan(ctx.sessionManager.getBranch());
			failure = undefined;
		} catch (error) {
			plan = undefined;
			failure = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(failure, "error");
		}
		updateStatus(ctx);
	}

	function beginInteraction(signal?: AbortSignal): { controller: AbortController; signal: AbortSignal; revision: number } {
		const controller = new AbortController();
		interaction = controller;
		return { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, revision };
	}

	pi.registerFlag("plan", { description: "Start in read-only planning mode", type: "boolean", default: false });
	pi.registerCommand("plan", {
		description: "Toggle planning; /plan on|off [prompt] sets the mode and optionally sends a prompt",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const match = /^(on|off)\b\s*([\s\S]*)$/i.exec(trimmed);
			const prompt = (match ? match[2] : trimmed).trim();
			const enabled = match ? match[1].toLowerCase() === "on" : prompt ? true : !(requestedMode ?? !!plan);
			if (ctx.isIdle()) manualMode(ctx, enabled);
			else {
				invalidate();
				requestedMode = enabled;
				ctx.ui.notify(`Plan mode ${enabled ? "on" : "off"} after the current tool batch.`);
			}
			if (prompt) pi.sendUserMessage(prompt, { ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }) });
		},
	});
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: () => pi.sendUserMessage("/plan", { expandPromptTemplates: true }),
	});

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		description: "Enter read-only planning when the user requests a plan or agreement before implementation. Returns a scratchpad Markdown path to develop with ordinary file tools. Call this tool alone.",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute(toolCallId, _params, signal, _onUpdate, ctx) {
			requireSoloCall(ctx, toolCallId);
			if (signal?.aborted) return toolResult({ status: "cancelled", message: "Planning entry cancelled." }, { terminate: true });
			const active = enter(ctx, true);
			return toolResult({ status: "planning", message: `Planning · ${active.path}`, planPath: active.path }, {}, planningNotice(active));
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", "Enter plan mode"), 0, 0),
		renderResult: renderTextResult,
	});

	pi.registerTool({
		name: "ask_question",
		label: "Ask question",
		description: "Ask the user for decisions or clarification, in any mode. Presents optional choices with a free-text alternative and returns the user's answers. Use exit_plan_mode for plan approval.",
		exposure: "model-only",
		executionMode: "sequential",
		parameters: Type.Object({
			questions: Type.Array(Type.Object({
				question: Type.String({ minLength: 1, maxLength: 2000 }),
				options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 8 })),
			}), { minItems: 1, maxItems: 4 }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return toolResult({ status: "unavailable", message: "User interaction is unavailable. Ask in your response and wait for user input." }, { terminate: true });
			const dialog = beginInteraction(signal);
			try {
				const result = await askQuestions(ctx, params.questions, dialog.signal);
				const cancelled = result.cancelled || dialog.revision !== revision;
				return toolResult({
					status: cancelled ? "cancelled" : "answered",
					message: [cancelled ? "Question cancelled. Wait for the user." : "User answers:", ...result.answers.map(({ question, answer }) => `${question}\n${answer}`)].join("\n\n"),
					answers: result.answers,
				}, cancelled ? { terminate: true } : {});
			} finally { if (interaction === dialog.controller) interaction = undefined; }
		},
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", "Ask question") + (args.questions?.length ? ` · ${args.questions.length}` : ""), 0, 0),
		renderResult: renderTextResult,
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Review plan",
		description: "Present the completed plan file for user approval. The user can execute from the planning checkpoint, continue here, or request revisions. Planning ends only on approval. Call this tool alone.",
		exposure: "model-only",
		executionMode: "sequential",
		renderShell: "self",
		parameters: Type.Object({ plan_path: Type.String({ description: "Absolute Markdown path returned by enter_plan_mode or the planning notice.", minLength: 1 }) }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!plan) return toolResult({ status: "inactive", message: "Plan mode is already off." });
			requireSoloCall(ctx, toolCallId);
			if (!plan.checkpointId) throw new Error("Wait for the planning entry turn to finish before requesting approval");
			const active = { ...plan };
			const snapshot = readPlan(active, params.plan_path);
			if (!ctx.hasUI) return toolResult({ status: "unavailable", snapshot, message: "Plan saved. Approval requires an interactive or RPC client; planning remains active." }, { terminate: true }, snapshot.markdown + "\n\nApproval requires an interactive or RPC client; planning remains active.");
			if (ctx.hasPendingMessages()) return toolResult({ status: "pending_input", snapshot, message: "Process the queued user input before requesting approval." });
			const dialog = beginInteraction(signal);
			const sessionId = ctx.sessionManager.getSessionId();
			const current = () => !dialog.signal.aborted && dialog.revision === revision && plan?.id === active.id && ctx.sessionManager.getSessionId() === sessionId;
			try {
				onUpdate?.(toolResult({ status: "review", snapshot, message: "Awaiting approval" }, {}, snapshot.markdown));
				const choice = await ctx.ui.select("Plan ready", [...APPROVAL_CHOICES], { signal: dialog.signal });
				if (!current() || !choice || choice === "Keep planning") return toolResult({ status: "cancelled", snapshot, message: "Planning remains active. Waiting for user input." }, { terminate: true });
				if (choice === "Request changes") {
					const feedback = await ctx.ui.input("What should change?", "Plan feedback", { signal: dialog.signal });
					if (!current() || !feedback?.trim()) return toolResult({ status: "cancelled", snapshot, message: "Planning remains active. Waiting for user input." }, { terminate: true });
					return toolResult({ status: "revise", snapshot, message: `Requested changes:\n${feedback}` });
				}
				if (choice !== "Execute from checkpoint" && choice !== "Continue here") return toolResult({ status: "cancelled", snapshot, message: "Planning remains active." }, { terminate: true });
				if (ctx.hasPendingMessages()) return toolResult({ status: "pending_input", snapshot, message: "New user input is queued. Process it, then request approval again." });
				if (readPlan(active, params.plan_path).sha256 !== snapshot.sha256) return toolResult({ status: "changed", snapshot, message: "The plan changed during review. Present its latest version for approval." });
				if (choice === "Continue here") {
					invalidate();
					plan = undefined;
					save(ctx);
					return toolResult({ status: "approved", snapshot, message: "Approved · continuing here" }, {}, executionHandoff(snapshot));
				}
				const token = randomUUID();
				handoff = { token, sessionId, revision, plan: active, snapshot, toolCallId, signal };
				return toolResult({ status: "handoff", snapshot, token, message: "Approved · execution will branch from the planning checkpoint after this turn settles." }, { terminate: true });
			} finally { if (interaction === dialog.controller) interaction = undefined; }
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", "Plan"), 0, 0),
		renderResult: renderPlanResult,
	});

	// Tool contexts cannot navigate. Dispatch a token-guarded command only after final settlement.
	pi.registerCommand("plan-handoff", {
		description: "Complete an approved planning handoff (internal)",
		handler: async (token, ctx) => {
			const pending = handoff;
			if (!pending || token.trim() !== pending.token) { ctx.ui.notify("No matching approved plan handoff.", "warning"); return; }
			const valid = () => handoff === pending && revision === pending.revision && !pending.signal?.aborted &&
				ctx.sessionManager.getSessionId() === pending.sessionId && ctx.isIdle() && !ctx.hasPendingMessages();
			if (!valid() || !pending.approvalEntryId || !pending.plan.checkpointId ||
				!ctx.sessionManager.getBranch().some((entry) => entry.id === pending.approvalEntryId) ||
				ctx.sessionManager.getEntry(pending.plan.checkpointId)?.type !== "custom") {
				invalidate();
				ctx.ui.notify("Handoff cancelled: session or input changed. Planning remains active.", "warning");
				return;
			}
			try {
				const carryPermissions = sandbox.carryPermissions();
				navigating = pending.token;
				const result = await ctx.navigateTree(pending.plan.checkpointId, { summarize: false });
				if (result.cancelled) { invalidate(); ctx.ui.notify("Checkpoint navigation cancelled; planning remains active.", "warning"); return; }
				if (!valid() || ctx.sessionManager.getLeafId() !== pending.plan.checkpointId) {
					invalidate();
					ctx.ui.notify("Handoff interrupted. No implementation was started.", "warning");
					return;
				}
				carryPermissions();
				invalidate();
				plan = undefined;
				save(ctx);
				pi.sendMessage({ customType: "plan-mode-execute", content: executionHandoff(pending.snapshot), display: true, details: pending.snapshot }, { triggerTurn: false });
				// A first-session manual checkpoint precedes the initial system message. The normal
				// prompt pipeline reinstates all prompt sections; triggerTurn alone bypasses it.
				pi.sendUserMessage("Implement the approved plan above.");
			} catch (error) {
				invalidate();
				ctx.ui.notify(`Plan handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally { navigating = undefined; }
		},
	});

	pi.registerMessageRenderer<PlanSnapshot>("plan-mode-execute", (message) => renderPlanResult(toolResult({
		status: "approved", snapshot: message.details, message: "Approved · executing from planning checkpoint",
	})));

	pi.on("before_agent_start", () => {
		if (failure || sandboxFailure) return { message: { customType: "plan-mode-notice", content: (failure ?? sandboxFailure)!, display: false } };
		if (plan) return { message: { customType: "plan-mode-notice", content: planningNotice(plan), display: false } };
	});
	pi.on("tool_call", () => {
		if (failure || sandboxFailure) return { block: true, reason: (failure ?? sandboxFailure)!, terminate: true };
		if (handoff) return { block: true, reason: "Waiting for the approved checkpoint handoff.", terminate: true };
	});
	pi.on("input", () => { invalidate(); });
	pi.on("message_start", (event) => {
		if (event.message.role === "user" && (handoff || interaction)) invalidate();
	});
	pi.on("turn_start", () => { if (handoff) invalidate(); });
	pi.on("turn_end", (event, ctx) => {
		if (requestedMode !== undefined) {
			const enabled = requestedMode;
			requestedMode = undefined;
			manualMode(ctx, enabled);
		}
		checkpoint(ctx);
		if (handoff) {
			const index = event.toolResults.findIndex((result) => result.toolCallId === handoff?.toolCallId && !result.isError &&
				(result.details as { token?: string } | undefined)?.token === handoff?.token);
			if (event.outcome !== "completed" || index < 0) invalidate();
			else handoff.approvalEntryId = event.toolResultEntryIds[index];
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (requestedMode !== undefined) {
			const enabled = requestedMode;
			requestedMode = undefined;
			pi.sendUserMessage(`/plan ${enabled ? "on" : "off"}`, { expandPromptTemplates: true });
		}
		const pending = handoff;
		if (!pending || pending.dispatched) return;
		if (pending.signal?.aborted || !pending.approvalEntryId || ctx.hasPendingMessages()) { invalidate(); return; }
		pending.dispatched = true;
		pi.sendUserMessage(`/plan-handoff ${pending.token}`, { expandPromptTemplates: true });
	});
	pi.on("session_before_tree", () => { if (!navigating) { invalidate(); requestedMode = undefined; } });
	pi.on("session_tree", (_event, ctx) => { restore(ctx); });
	pi.on("session_before_switch", () => { invalidate(); requestedMode = undefined; });
	pi.on("session_before_fork", () => { invalidate(); requestedMode = undefined; });
	pi.on("session_shutdown", () => { invalidate(); requestedMode = undefined; sandbox.dispose(); });
	pi.on("session_start", (event, ctx) => {
		invalidate();
		requestedMode = undefined;
		navigating = undefined;
		restore(ctx);
		if (event.reason === "startup" && pi.getFlag("plan") === true && !plan) manualMode(ctx, true);
	});
}
