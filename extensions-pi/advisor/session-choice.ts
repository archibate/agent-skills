import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { modelId } from "./pairings.ts";

export const CHOICE_ENTRY = "advisor-selection";
// Stable across /reload, distinct for each Pi process. A new launch's CLI override wins over old choices.
const launch = `${process.pid}:${performance.timeOrigin}`;
export interface SessionChoice { sessionId: string; launch: string; model: string | null }

export function sessionChoice(sessionId: string, model: string | null): SessionChoice {
	return { sessionId, launch, model: model === null ? null : modelId(model) };
}

/** Session-wide, not branch-relative. Forked sessions must not inherit a temporary selection. */
export function restoreChoice(entries: readonly SessionEntry[], sessionId: string, cliOverride: unknown): string | null | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== CHOICE_ENTRY) continue;
		const data = entry.data as Partial<SessionChoice> | undefined;
		if (!data || data.sessionId !== sessionId || (cliOverride !== undefined && data.launch !== launch)) continue;
		if (data.model === null) return null;
		try { return modelId(data.model); } catch { /* Ignore invalid session metadata. */ }
	}
	return undefined;
}
