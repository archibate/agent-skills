/** Pure accounting for agent working time; the clock is injectable for tests. */

export const ENTRY_TYPE = "session-time";

export interface RunTimes {
	activeMs: number;
	/** Provider request sent until the assistant message ended. */
	apiMs: number;
	/** Wall time while at least one tool ran; parallel calls are not double-counted. */
	toolMs: number;
	requests: number;
	/** Top-level tool calls; calls nested in e.g. codemode are inside their parent's time. */
	toolCalls: number;
}

export interface RunRecord extends Partial<Omit<RunTimes, "activeMs">> {
	v: 1;
	activeMs: number;
	aborted?: boolean;
	/** The session shut down before the run settled. */
	partial?: boolean;
}

export interface Totals extends RunTimes {
	runs: number;
	/** The most recently recorded run. */
	last?: RunTimes;
}

export const emptyTimes = (): RunTimes => ({ activeMs: 0, apiMs: 0, toolMs: 0, requests: 0, toolCalls: 0 });

/**
 * One run at a time. Time between transitions is credited to the current phase:
 * tools while any tool is open, else api while a request is open, else other.
 * Blocking user prompts pause every phase; their depth is tracked even while
 * idle so a run that starts under an open dialog starts paused.
 */
export class RunTracker {
	readonly now: () => number;
	#running = false;
	#mark = 0;
	#times = emptyTimes();
	#api = false;
	/** Between turn_start and the assistant message_end: the only window for loop requests. */
	#turn = false;
	#tools = new Set<string>();
	#depth = 0;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	get running(): boolean {
		return this.#running;
	}

	get waiting(): boolean {
		return this.#running && this.#depth > 0;
	}

	#pending(now: number): RunTimes {
		const times = { ...this.#times };
		if (!this.#running || this.#depth > 0) return times;
		const delta = Math.max(0, now - this.#mark);
		times.activeMs += delta;
		if (this.#tools.size > 0) times.toolMs += delta;
		else if (this.#api) times.apiMs += delta;
		return times;
	}

	/** Credits time up to now to the current phase before a transition. */
	#advance(): void {
		const now = this.now();
		this.#times = this.#pending(now);
		this.#mark = now;
	}

	/** Returns false when a run is already active. */
	start(): boolean {
		if (this.#running) return false;
		this.#running = true;
		this.#mark = this.now();
		this.#times = emptyTimes();
		this.#api = false;
		this.#turn = false;
		this.#tools.clear();
		return true;
	}

	promptStart(): void {
		this.#advance();
		this.#depth++;
	}

	promptEnd(): void {
		if (this.#depth === 0) return; // A stray end, e.g. after a reload, is ignored.
		this.#advance();
		this.#depth--;
	}

	turnStart(): void {
		if (this.#running) this.#turn = true;
	}

	/**
	 * Cache-warming requests also fire before_provider_request, during tools, dialogs
	 * or after the final reply, and never get a message_end; only a request inside a
	 * turn's assistant response counts.
	 */
	requestStart(): void {
		if (!this.#running || !this.#turn) return;
		this.#advance();
		if (!this.#api) this.#times.requests++; // Provider-level retries reuse the open request.
		this.#api = true;
	}

	requestEnd(): void {
		this.#turn = false;
		if (!this.#running || !this.#api) return;
		this.#advance();
		this.#api = false;
	}

	toolStart(id: string, nested: boolean): void {
		if (!this.#running || this.#tools.has(id)) return;
		this.#advance();
		this.#api = false; // Tools only start after the assistant message ended.
		this.#tools.add(id);
		if (!nested) this.#times.toolCalls++;
	}

	toolEnd(id: string): void {
		if (!this.#running || !this.#tools.has(id)) return;
		this.#advance();
		this.#tools.delete(id);
	}

	snapshot(): RunTimes {
		return this.#pending(this.now());
	}

	/** Ends the run and returns its times, or undefined when idle. */
	settle(): RunTimes | undefined {
		if (!this.#running) return undefined;
		const times = this.snapshot();
		this.#running = false;
		this.#api = false;
		this.#tools.clear();
		return times;
	}
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isRunRecord(data: unknown): data is RunRecord {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Partial<RunRecord>;
	return record.v === 1 && finite(record.activeMs);
}

/** Sums recorded runs over all entries, the same full-session scope Pi uses for cost. */
export function sumEntries(entries: readonly unknown[]): Totals {
	const totals: Totals = { ...emptyTimes(), runs: 0 };
	for (const entry of entries) {
		const { type, customType, data } = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (type !== "custom" || customType !== ENTRY_TYPE || !isRunRecord(data)) continue;
		addTimes(totals, data);
		totals.runs++;
		totals.last = addTimes(emptyTimes(), data);
	}
	return totals;
}

/** Adds `times` into `into`; missing or invalid breakdown fields count as zero. */
export function addTimes(into: RunTimes, times: Partial<RunTimes>): RunTimes {
	for (const key of ["activeMs", "apiMs", "toolMs", "requests", "toolCalls"] as const) {
		const value = times[key];
		if (finite(value)) into[key] += value;
	}
	return into;
}

/** `42s`, `12m 04s`, `1h 02m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
