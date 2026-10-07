import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CostRecord } from "./ledger.ts";

export const REGISTRATION = "subagent-cost.v1";
export interface Registration {
	childSessionFile: string;
	childSessionId: string;
	parentSessionFile: string;
}

/** Match Pi's accounting, including tool usage (already inclusive of nested calls). */
export function entryCost(entry: SessionEntry): number {
	let value: unknown;
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant" || message.role === "toolResult") value = message.usage?.cost.total;
	} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
		value = entry.usage?.cost.total;
	}
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid recorded USD cost");
	return value;
}

export function registrationIn(entries: SessionEntry[], childFile: string): { registration: Registration; index: number } | undefined {
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== REGISTRATION) continue;
		const data = entry.data as Partial<Registration> | undefined;
		// Forks copy markers too. Only this exact session's marker establishes ownership.
		if (data?.childSessionFile !== childFile) continue;
		if (typeof data.parentSessionFile !== "string" || typeof data.childSessionId !== "string") {
			throw new Error("Invalid subagent registration");
		}
		return { registration: data as Registration, index };
	}
	return undefined;
}

export class CostPublisher {
	private cost = 0;
	private sent = -1;
	private readonly registration: Registration;
	private readonly send: (record: CostRecord) => void;
	constructor(registration: Registration, send: (record: CostRecord) => void) {
		this.registration = registration;
		this.send = send;
	}

	add(entry: SessionEntry): void {
		const total = this.cost + entryCost(entry);
		if (!Number.isFinite(total)) throw new Error("Child cost overflow");
		this.cost = total;
	}

	flush(): void {
		if (this.cost === this.sent) return;
		this.send({ version: 1, ...this.registration, costUSD: this.cost });
		this.sent = this.cost; // Failed writes stay pending for the next event/shutdown/resume.
	}
}

/** Pi 1.0.4 adapter: all accounting-bearing append methods call _appendEntry synchronously.
 * Notify only after persistence succeeds. Never turn an accounting failure into a failed turn.
 */
export function observeAppends(manager: object, appended: (entry: SessionEntry) => void, failed: (error: unknown) => void): () => void {
	const host = manager as { _appendEntry(entry: SessionEntry): void };
	const original = host._appendEntry;
	if (typeof original !== "function") throw new Error("Pi's session append API changed; update subagent-cost");
	const own = Object.getOwnPropertyDescriptor(manager, "_appendEntry");
	const wrapped = function (this: typeof host, entry: SessionEntry): void {
		original.call(this, entry);
		try { appended(entry); }
		catch (error) { try { failed(error); } catch { /* Preserve the successful core append. */ } }
	};
	host._appendEntry = wrapped;
	return () => {
		if (host._appendEntry !== wrapped) return;
		if (own) Object.defineProperty(host, "_appendEntry", own);
		else Reflect.deleteProperty(host, "_appendEntry");
	};
}
