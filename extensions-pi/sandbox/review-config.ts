/** Automatic-review configuration available without loading the reviewer agent. */
export const REVIEWER_MODEL_FLAG = "reviewer-model";
export const DEFAULT_REVIEWER_MODEL = "openai-codex/gpt-6-luna";
export const AUTO_REVIEW_ENTRY = "sandbox-auto-review";
export const REVIEW_LIMITS = { timeoutMs: 60_000, requests: 4, tools: 8, contextBytes: 256 * 1024, outputTokens: 2048 };

export function validateReviewerModel(model: string): void {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1 || model.trim() !== model) {
		throw new Error(`--${REVIEWER_MODEL_FLAG} needs provider/model`);
	}
}
