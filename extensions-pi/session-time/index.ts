/**
 * Agent working time, split into API inference, tools and other: footer status
 * (live during runs) and a /session section. Runs span the first
 * before_agent_start/agent_start to agent_settled; blocking extension UI prompts
 * pause them. Each settled run is persisted as a custom entry.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPresentation, SUMMARY, type TimeSummary } from "./presentation.ts";
import { addTimes, emptyTimes, ENTRY_TYPE, formatDuration, RunTracker, sumEntries, type RunRecord, type RunTimes } from "./tracker.ts";

const STATUS_KEY = "session-time";
const TICK_MS = 1000;

type Paint = (color: "dim" | "warning", text: string) => string;

/**
 * Session total, then the current run (▶ running, ⏸ waiting while a dialog waits
 * on the user) or the last finished run (■ ran). The breakdown lives in /session.
 */
export function statusText(summary: TimeSummary, paint: Paint = (_color, text) => text): string | undefined {
	const { total, current, last, waiting } = summary;
	if (!current && summary.runs === 0) return undefined;
	const text = paint("dim", `⏱ ${formatDuration(total.activeMs)}`);
	if (current && waiting) return text + paint("warning", ` · ⏸ waiting ${formatDuration(current.activeMs)}`);
	if (current) return text + paint("dim", ` · ▶ running ${formatDuration(current.activeMs)}`);
	return last ? text + paint("dim", ` · ■ ran ${formatDuration(last.activeMs)}`) : text;
}

type Handlers = {
	start(ctx: ExtensionContext): void;
	update(ctx: ExtensionContext, change: (tracker: RunTracker) => void): void;
	settle(ctx: ExtensionContext, aborted: boolean): void;
};

export default function sessionTime(pi: ExtensionAPI): void {
	register(pi);
}

/** `now` is injectable for tests; Pi's loader calls the default export with `pi` only. */
export function register(pi: ExtensionAPI, now?: () => number): void {
	installPresentation();
	let release: (() => void) | undefined;
	let handlers: Handlers | undefined;

	pi.on("session_start", (_event, ctx) => {
		release?.();
		const manager = ctx.sessionManager;
		const tracker = new RunTracker(now);
		let { runs: recordedRuns, last, ...recorded } = sumEntries(manager.getEntries());
		let ticker: ReturnType<typeof setInterval> | undefined;
		const summary = (): TimeSummary => {
			const current = tracker.running ? tracker.snapshot() : undefined;
			const total = addTimes({ ...recorded }, current ?? {});
			return { total, runs: recordedRuns, current, last, waiting: tracker.waiting };
		};
		const stopTicker = () => {
			if (ticker !== undefined) clearInterval(ticker);
			ticker = undefined;
		};
		const render = (target: ExtensionContext) => {
			if (target.mode !== "tui") return;
			try {
				const { theme } = target.ui;
				target.ui.setStatus(STATUS_KEY, statusText(summary(), (color, text) => theme.fg(color, text)));
			} catch {
				stopTicker(); // A stale context after replacement must not keep ticking.
			}
		};
		const record = (times: RunTimes, extra: Pick<RunRecord, "aborted" | "partial">) => {
			const data: RunRecord = {
				v: 1,
				activeMs: Math.round(times.activeMs),
				apiMs: Math.round(times.apiMs),
				toolMs: Math.round(times.toolMs),
				requests: times.requests,
				toolCalls: times.toolCalls,
				...extra,
			};
			addTimes(recorded, data);
			recordedRuns++;
			last = addTimes(emptyTimes(), data);
			pi.appendEntry(ENTRY_TYPE, data);
		};

		Reflect.set(manager, SUMMARY, summary);
		handlers = {
			start(target) {
				if (!tracker.start()) return;
				render(target);
				if (target.mode === "tui") {
					stopTicker();
					ticker = setInterval(() => render(target), TICK_MS);
					ticker.unref?.();
				}
			},
			update(target, change) {
				change(tracker);
				if (tracker.running) render(target);
			},
			settle(target, aborted) {
				stopTicker();
				const times = tracker.settle();
				if (times === undefined) return;
				record(times, aborted ? { aborted } : {});
				render(target);
			},
		};
		release = () => {
			stopTicker();
			const times = tracker.settle();
			if (times !== undefined) {
				try { record(times, { partial: true }); } catch { /* Shutdown must not fail on a closed session. */ }
			}
			if (Reflect.get(manager, SUMMARY) === summary) Reflect.deleteProperty(manager, SUMMARY);
			handlers = undefined;
			release = undefined;
		};
		render(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => { handlers?.start(ctx); });
	pi.on("agent_start", (_event, ctx) => { handlers?.start(ctx); });
	pi.on("ui_prompt_start", (_event, ctx) => { handlers?.update(ctx, (t) => t.promptStart()); });
	pi.on("ui_prompt_end", (_event, ctx) => { handlers?.update(ctx, (t) => t.promptEnd()); });
	// Compaction and summaries never reach before_provider_request and count as other;
	// cache-warming requests do, and the tracker ignores them outside a turn's response.
	pi.on("turn_start", (_event, ctx) => { handlers?.update(ctx, (t) => t.turnStart()); });
	pi.on("before_provider_request", (_event, ctx) => { handlers?.update(ctx, (t) => t.requestStart()); });
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") handlers?.update(ctx, (t) => t.requestEnd());
	});
	pi.on("tool_execution_start", (event, ctx) => {
		handlers?.update(ctx, (t) => t.toolStart(event.toolCallId, event.parentToolCallId !== undefined));
	});
	pi.on("tool_execution_end", (event, ctx) => { handlers?.update(ctx, (t) => t.toolEnd(event.toolCallId)); });
	pi.on("agent_settled", (event, ctx) => { handlers?.settle(ctx, event.aborted); });
	pi.on("session_shutdown", () => { release?.(); });
}
