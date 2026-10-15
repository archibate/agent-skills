/** Automatic-review configuration available without loading the reviewer agent. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const REVIEWER_MODEL_FLAG = "reviewer-model";
export const REVIEWER_THINKING_FLAG = "reviewer-thinking";
export const REVIEWER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReviewerThinking = (typeof REVIEWER_THINKING_LEVELS)[number];
export const DEFAULT_REVIEWER_THINKING: ReviewerThinking = "low";
/** User-level file in the agent directory; project-local configuration is not read. */
export const SANDBOX_CONFIG_FILE = "sandbox.json";
export const AUTO_REVIEW_ENTRY = "sandbox-auto-review";
export const REVIEW_LIMITS = { timeoutMs: 60_000, requests: 4, tools: 8, contextBytes: 256 * 1024, outputTokens: 2048 };
const CONFIG_LIMIT = 64 * 1024;

export function validateReviewerModel(model: string): void {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1 || model.trim() !== model) {
		throw new Error(`--${REVIEWER_MODEL_FLAG} needs provider/model`);
	}
}

/** `--reviewer-thinking`, else low. */
export function resolveReviewerThinking(flag: unknown): ReviewerThinking {
	if (flag === undefined || flag === "") return DEFAULT_REVIEWER_THINKING;
	if (typeof flag === "string" && (REVIEWER_THINKING_LEVELS as readonly string[]).includes(flag)) return flag as ReviewerThinking;
	throw new Error(`--${REVIEWER_THINKING_FLAG} must be one of ${REVIEWER_THINKING_LEVELS.join(", ")}`);
}

/** `--reviewer-model`, else `reviewerModel` in `path`. There is no built-in default. */
export function resolveReviewerModel(flag: unknown, path: string): string {
	const model = typeof flag === "string" && flag !== "" ? flag : readConfiguredReviewerModel(path);
	if (model === undefined) {
		throw new Error(`automatic review needs a reviewer model: set "reviewerModel" in ${path} or pass --${REVIEWER_MODEL_FLAG} provider/model`);
	}
	validateReviewerModel(model);
	return model;
}

/** A missing file or key means no configured model; anything malformed is an error. */
export function readConfiguredReviewerModel(path: string): string | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let source: string;
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > CONFIG_LIMIT) throw new Error(`${path} must be a regular file no larger than 64 KiB`);
		const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = readSync(fd, buffer, size, buffer.length - size, null);
			if (!read) break;
			size += read;
		}
		if (size > CONFIG_LIMIT) throw new Error(`${path} exceeds 64 KiB`);
		source = buffer.toString("utf8", 0, size);
	} finally { closeSync(fd); }
	let data: unknown;
	try { data = JSON.parse(source); } catch { throw new Error(`${path} is not valid JSON`); }
	if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).some((key) => key !== "reviewerModel")) {
		throw new Error(`${path} must be an object with only "reviewerModel"`);
	}
	const model = (data as { reviewerModel?: unknown }).reviewerModel;
	if (model === undefined) return undefined;
	if (typeof model !== "string") throw new Error(`"reviewerModel" in ${path} must be a provider/model string`);
	return model;
}
