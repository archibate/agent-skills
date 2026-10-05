/**
 * The opt-in gate: the sandbox applies only when the launch asked for it, with `--enable-sandbox`,
 * `--permissions`, or `--reviewer`. Without one, the extension registers nothing that changes tool
 * behavior: `bash` stays pi's built-in, `job_start` keeps its plain form, and no call is reviewed.
 *
 * The flags are read live rather than cached at load: pi applies CLI/`extensionFlagValues` to the
 * runtime after the extensions load, and a `/btw` side session reloads them with fresh flag
 * storage. The argv fallback keeps such a side session consistent with the launch flags, and also
 * covers SDK callers that pass `extensionFlagValues` instead of argv.
 */

import { PERMISSIONS_FLAG } from "./permissions.ts";
import { REVIEWER_FLAG } from "./review.ts";

export const ENABLE_SANDBOX_FLAG = "enable-sandbox";
export const SANDBOX_FLAGS = [ENABLE_SANDBOX_FLAG, PERMISSIONS_FLAG, REVIEWER_FLAG] as const;

/** A flag counts as set when it is `true` or a non-blank string. */
function provided(value: boolean | string | undefined): boolean {
	return typeof value === "string" ? value.trim() !== "" : value === true;
}

/** True when an argv token names one of the enabling flags, as `--name` or `--name=value`. */
export function argvRequestsSandbox(argv: readonly string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") break;
		if (!arg.startsWith("--")) continue;
		const name = arg.slice(2).split("=", 1)[0] ?? "";
		if ((SANDBOX_FLAGS as readonly string[]).includes(name)) return true;
	}
	return false;
}

/** Whether this launch or runtime asked for the sandbox, by runtime flags or by argv. */
export function sandboxRequested(
	flags: { enable?: boolean | string; permissions?: boolean | string; reviewer?: boolean | string },
	argv: readonly string[],
): boolean {
	return (
		provided(flags.enable) || provided(flags.permissions) || provided(flags.reviewer) || argvRequestsSandbox(argv)
	);
}
