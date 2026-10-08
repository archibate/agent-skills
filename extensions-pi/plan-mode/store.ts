import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATE_ENTRY = "plan-mode-state";
export const CHECKPOINT_ENTRY = "plan-mode-checkpoint";
export const MAX_PLAN_BYTES = 64 * 1024;

export interface Plan {
	id: string;
	path: string;
	checkpointId: string | null;
}

export interface PlanSnapshot {
	path: string;
	markdown: string;
	sha256: string;
}

function directory(path: string, privateAccess: boolean): void {
	try { mkdirSync(path, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		(process.getuid && (stat.uid !== process.getuid() || (stat.mode & (privateAccess ? 0o077 : 0o022)) !== 0))) {
		throw new Error(`Unsafe plan directory: ${path}`);
	}
}

/** Same retained, session-owned location as the scratchpad extension; works without that extension too. */
export function createPlan(sessionId: string): Plan {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) throw new Error("Invalid plan session ID");
	const configured = process.env.XDG_CACHE_HOME;
	const cache = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	const root = realpathSync(cache);
	directory(root, false);
	const app = join(root, "pi");
	const scratch = join(app, "scratchpad");
	const session = join(scratch, sessionId);
	directory(app, false);
	directory(scratch, true);
	directory(session, true);
	const id = randomUUID();
	const path = join(session, `plan-${id}.md`);
	writeFileSync(path, "", { flag: "wx", mode: 0o600 });
	return { id, path, checkpointId: null };
}

/** Read bounded, regular UTF-8 files only. Never follow a submitted alternate path or a symlink. */
export function readPlan(plan: Plan, submittedPath: string): PlanSnapshot {
	if (resolve(submittedPath) !== plan.path) throw new Error(`Use the active plan file: ${plan.path}`);
	if (realpathSync(plan.path) !== plan.path) throw new Error("The plan file must not be a symlink");
	const fd = openSync(plan.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("The plan must be a regular Markdown file");
		if (stat.size > MAX_PLAN_BYTES) throw new Error(`Keep the plan within ${MAX_PLAN_BYTES / 1024} KiB`);
		const bytes = Buffer.alloc(MAX_PLAN_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		if (length > MAX_PLAN_BYTES) throw new Error(`Keep the plan within ${MAX_PLAN_BYTES / 1024} KiB`);
		const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
		if (!markdown.trim()) throw new Error("Write the plan before requesting approval");
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(markdown)) throw new Error("Remove terminal control characters from the plan");
		return { path: plan.path, markdown, sha256: createHash("sha256").update(markdown).digest("hex") };
	} finally { closeSync(fd); }
}

/** Branch-relative state. Approval transactions deliberately never resume automatically. */
export function restorePlan(entries: readonly SessionEntry[]): Plan | undefined {
	// A later authoritative state (including an explicit /plan off reset) supersedes old damage.
	const stateIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
	const state = entries[stateIndex];
	if (state?.type !== "custom") return undefined;
	const data = state.data as { version?: unknown; plan?: Partial<Plan> | null; failure?: unknown } | undefined;
	if (typeof data?.failure === "string") throw new Error(data.failure);
	if (data?.version !== 1 || !(data.plan === null || (data.plan &&
		typeof data.plan.id === "string" && typeof data.plan.path === "string" && isAbsolute(data.plan.path) &&
		(data.plan.checkpointId === null || typeof data.plan.checkpointId === "string")))) {
		throw new Error("Invalid saved planning state. Use /plan off to reset it explicitly.");
	}
	if (!data.plan) return undefined;
	const plan = { ...data.plan } as Plan;
	for (let index = stateIndex + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY &&
			(entry.data as { planId?: string } | undefined)?.planId === plan.id) plan.checkpointId = entry.id;
	}
	return plan;
}

export function planningNotice(plan: Plan): string {
	return `[PLAN MODE ACTIVE]\nPlan file: ${JSON.stringify(plan.path)}\nInvestigate read-only; the session scratchpad is the writable exception. Develop the plan in this Markdown file using ordinary file tools. Make it self-contained: objective, constraints, decisions, relevant files, implementation steps, and verification. Use ask_question for decisions that require the user. When ready, call exit_plan_mode alone to present the file for approval.\nThis notice supersedes earlier plan-mode notices.`;
}

export const OFF_NOTICE = "[PLAN MODE OFF]\nPlanning has ended. Earlier planning restrictions are retired; follow the user's instructions for implementation.";

export function executionHandoff(snapshot: PlanSnapshot): string {
	return `${OFF_NOTICE}\nThe user approved this exact plan for implementation. Execute it now.\nPlan file: ${JSON.stringify(snapshot.path)}\nApproved SHA-256: ${snapshot.sha256}\n\n${snapshot.markdown}`;
}
