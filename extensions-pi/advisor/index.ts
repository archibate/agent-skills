import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Advisor } from "./advisor.ts";
import { readConfig } from "./config.ts";
import { readPolicy, resolveAdvisor, type AdvisorPolicy, type ModelIdentity } from "./pairings.ts";

/** SDK hosts with an explicit agentDir can inject that same directory via an inline factory. */
export default function registerAdvisor(pi: ExtensionAPI, agentDir = getAgentDir()) {
	pi.registerFlag("advisor", { description: "Override advisor pairings for this process: exact provider/model, or none to disable.", type: "string" });
	pi.registerFlag("advisor-thinking", { description: "Advisor reasoning effort. Default: high.", type: "string" });
	pi.registerFlag("advisor-max-tokens", { description: "Advisor total output-token ceiling, including reasoning. Default: 8192.", type: "string" });
	pi.registerFlag("advisor-cache", { description: "Advisor cache retention: none, short (default), long. Anthropic: 5m or 1h.", type: "string" });
	pi.registerFlag("advisor-timeout", { description: "Advisor deadline in seconds. Default: 180.", type: "string" });
	const path = join(agentDir, "advisor.json");
	let advisor: Advisor | undefined;
	let policy: AdvisorPolicy | undefined;
	let loadError: Error | undefined;
	let errorReported = false;
	let enabled = false;
	let selected: string | undefined;
	let mainId: string | undefined;

	const tool: ToolDefinition = {
		name: "advisor",
		label: "Advisor",
		description: "Consult an independent, tool-free reviewer of your current conversation. Automatically sends current instructions, retained messages and compaction summary, tool calls/results, and images to the configured advisor model; private reasoning is excluded. Costs a separate model inference. Gather relevant evidence first. Use before consequential decisions, when an approach is stuck, or to review substantial completed work and verification results. If the advisor needs missing evidence, gather it and consult again. No arguments; prior advice remains part of the transcript.",
		parameters: Type.Object({}, { additionalProperties: false }),
		exposure: "hidden",
		defaultActive: false,
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async execute(_id, _params, signal, onUpdate, ctx) {
			reconcile(ctx.model);
			if (loadError) throw loadError;
			if (!selected) throw new Error("Advisor is disabled for the current main model. Configure a pairing or launch with --advisor provider/model.");
			const config = readConfig((name) => pi.getFlag(name), selected);
			onUpdate?.({ content: [{ type: "text", text: `Consulting ${config.model}…` }], details: undefined });
			return (advisor ??= new Advisor()).consult(ctx, config, signal);
		},
	};
	pi.registerTool(tool);

	function reconcile(main: ModelIdentity | undefined): void {
		if (!policy && !loadError) {
			try { policy = readPolicy(pi.getFlag("advisor"), path); }
			catch (error) { loadError = new Error(`Advisor configuration (--advisor or ${path}): ${error instanceof Error ? error.message : String(error)}`); }
		}
		const next = policy && resolveAdvisor(policy, main);
		const nextMainId = main && `${main.provider}/${main.id}`;
		if (next !== selected || nextMainId !== mainId) advisor?.reset();
		selected = next;
		mainId = nextMainId;
		const active = pi.getActiveTools();
		const wantEnabled = selected !== undefined;
		if (enabled !== wantEnabled || active.includes("advisor") !== wantEnabled) {
			// Snapshot before registration: Pi's refresh can otherwise reactivate unrelated allowed tools.
			if (enabled !== wantEnabled) pi.registerTool({ ...tool, exposure: wantEnabled ? "model-only" : "hidden" });
			enabled = wantEnabled;
			pi.setActiveTools([...active.filter((name) => name !== "advisor"), ...(enabled ? ["advisor"] : [])]);
		}
		if (loadError && !errorReported) { errorReported = true; throw loadError; }
	}

	pi.on("session_start", (_event, ctx) => {
		advisor?.dispose();
		advisor = undefined;
		policy = undefined;
		loadError = undefined;
		errorReported = false;
		reconcile(ctx.model);
	});
	pi.on("model_select", (event) => { reconcile(event.model); });
	pi.on("before_agent_start", (_event, ctx) => { reconcile(ctx.model); });
	pi.on("session_tree", (_event, ctx) => { advisor?.reset(); reconcile(ctx.model); });
	pi.on("session_compact", () => { advisor?.reset(); });
	pi.on("session_shutdown", () => { advisor?.dispose(); advisor = undefined; });
}
