import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import { modelId } from "./pairings.ts";
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface AdvisorConfig {
	model: string;
	thinking: ModelThinkingLevel;
	maxTokens: number;
	cache: "none" | "short" | "long";
	timeoutMs: number;
}

export function readConfig(flag: (name: string) => unknown, selectedModel: string): AdvisorConfig {
	const model = modelId(selectedModel);
	const thinking = String(flag("advisor-thinking") ?? "high");
	if (!(LEVELS as readonly string[]).includes(thinking)) throw new Error(`--advisor-thinking must be ${LEVELS.join(", ")}.`);
	const cache = String(flag("advisor-cache") ?? "short");
	if (cache !== "none" && cache !== "short" && cache !== "long") throw new Error("--advisor-cache must be none, short, or long.");
	function integer(name: string, fallback: number, min: number, max: number) {
		const value = flag(name);
		const number = value === undefined ? fallback : Number(value);
		if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
		return number;
	}
	return {
		model, thinking: thinking as ModelThinkingLevel, cache,
		maxTokens: integer("advisor-max-tokens", 8192, 1024, 131072),
		timeoutMs: integer("advisor-timeout", 180, 1, 1800) * 1000,
	};
}
