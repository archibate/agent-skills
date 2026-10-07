import { getSupportedThinkingLevels, hasApi, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AdvisorConfig } from "./config.ts";

/** A standalone reviewer uses static effort, no inherited fallback policy, and the model's output limit unless explicitly lowered. */
export function prepareModel(selected: Model<Api>, config: AdvisorConfig): Model<Api> {
	// Pi resolves virtual models after this boundary, replacing the capped metadata and API policy.
	if (selected.api === "pi-virtual") throw new Error("Advisor requires a physical provider/model, not a virtual router; select its concrete model in the pairing or --advisor override.");
	const levels = getSupportedThinkingLevels(selected);
	if (!levels.includes(config.thinking)) throw new Error(`${config.model} does not support advisor effort ${config.thinking}; choose --advisor-thinking from ${levels.join(", ")}.`);
	const model = { ...selected, maxTokens: Math.min(selected.maxTokens, config.maxTokens ?? selected.maxTokens) };
	if (hasApi(model, "anthropic-messages")) {
		model.compat = {
			...model.compat,
			forceAdaptiveThinking: model.compat?.supportsMidConvoEffort === true || model.compat?.forceAdaptiveThinking === true,
			supportsMidConvoEffort: false,
			allowedFallbackModels: [],
		};
		if (model.reasoning && config.thinking !== "off" && !model.compat.forceAdaptiveThinking && model.maxTokens < 2048) {
			throw new Error("Manual-thinking Anthropic advisors need at least 2048 total output tokens; increase --advisor-max-tokens or use supported off/adaptive thinking.");
		}
	}
	return model;
}

export function validateAnthropicRequest(payload: unknown, maxTokens: number): void {
	const body = payload as { max_tokens?: number; thinking?: { type?: string; budget_tokens?: number }; tools?: unknown[]; fallbacks?: unknown[] };
	if (!body || !Number.isSafeInteger(body.max_tokens) || body.max_tokens! <= 0 || body.max_tokens! > maxTokens) throw new Error("Advisor provider did not preserve the output-token ceiling.");
	if (body.tools?.length || body.fallbacks?.length) throw new Error("Advisor provider unexpectedly enabled tools or fallback models; no request was sent.");
	if (body.thinking?.type === "enabled" && (!Number.isSafeInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens! < 1024 || body.thinking.budget_tokens! >= body.max_tokens!)) {
		throw new Error("Advisor has insufficient output/context room for manual thinking; compact the main session or increase --advisor-max-tokens.");
	}
}

export interface ObservedResponse { latest?: AssistantMessage; terminal: boolean }

/** Consume events as well as the result so aborts retain already-reported input/cache usage. */
export async function observeResponse(stream: AssistantMessageEventStream, observed: ObservedResponse): Promise<AssistantMessage> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") {
			observed.latest = event.type === "done" ? event.message : event.error;
			observed.terminal = true;
		} else observed.latest = event.partial;
	}
	const response = await stream.result();
	observed.latest = response;
	observed.terminal = true;
	return response;
}

/** Give cooperative cancellation a bounded chance to return final usage, without hanging on a broken adapter. */
export async function settleCancelled(pending: Promise<AssistantMessage>, graceMs = 500): Promise<AssistantMessage | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending.catch(() => undefined),
			new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), graceMs); }),
		]);
	} finally { clearTimeout(timer); }
}
