import { stripVTControlCharacters } from "node:util";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { formatDuration, type RunTimes } from "./tracker.ts";

export const SUMMARY = Symbol.for("pi.session-time.summary");
const IMPLEMENTATION = Symbol.for("pi.session-time.implementation");
// Shared with rmb-cost/subagent-cost: lets them find their own wrappers beneath ours.
const BASE_METHOD = Symbol.for("pi.cost.base-method");

export interface TimeSummary {
	/** Recorded runs plus the current run. */
	total: RunTimes;
	runs: number;
	/** Present while a run is active. */
	current?: RunTimes;
	/** The last finished run, when any. */
	last?: RunTimes;
	waiting: boolean;
}
type SummarySource = { [SUMMARY]?: () => TimeSummary };
interface TextComponent { build?: () => string; invalidate(): void }
interface SessionHost {
	sessionManager: SummarySource;
	chatContainer: { children: TextComponent[] };
	handleSessionCommand(): void;
}

/** Reuse the styling of an existing `label` in `template` for `replacement`. */
function restyle(template: string | undefined, label: string, replacement: string): string {
	const at = template?.indexOf(label) ?? -1;
	if (!template || at < 0) return replacement;
	const closing = /^(?:\x1b\[[0-9;]*m)*/.exec(template.slice(at + label.length))![0];
	return `${template.slice(0, at)}${replacement}${closing}`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Working time outside requests and tools: hooks, compaction, retry backoff. */
export const otherMs = (t: RunTimes) => Math.max(0, t.activeMs - t.apiMs - t.toolMs);

/** Called on theme rebuilds too; input is generated /session text, never arbitrary chat. */
export function insertTime(text: string, summary: TimeSummary): string {
	const lines = text.split("\n");
	const plain = lines.map((line) => stripVTControlCharacters(line));
	const tokens = plain.indexOf("Tokens");
	const header = restyle(lines[tokens], "Tokens", "Time");
	const labelTemplate = lines[plain.findIndex((line) => line.startsWith("Total:"))];
	const label = (name: string) => restyle(labelTemplate, "Total:", `${name}:`);
	// Sub-items are indented like Pi's Input > Cached/Uncached.
	const breakdown = (t: RunTimes) => [
		`  ${label("API inference")} ${formatDuration(t.apiMs)} (${count(t.requests, "request")})`,
		`  ${label("Tools")} ${formatDuration(t.toolMs)} (${count(t.toolCalls, "call")})`,
		`  ${label("Other")} ${formatDuration(otherMs(t))}`,
	];
	const { total, current, last } = summary;
	const block = [
		header,
		`${label("Agent working")} ${formatDuration(total.activeMs)} (${count(summary.runs, "run")})`,
		...breakdown(total),
	];
	if (current) {
		block.push(`${label("Current run")} ${formatDuration(current.activeMs)}${summary.waiting ? " (waiting)" : ""}`, ...breakdown(current));
	} else if (last) {
		block.push(`${label("Last run")} ${formatDuration(last.activeMs)}`, ...breakdown(last));
	}
	if (tokens < 0) return `${text.trimEnd()}\n\n${block.join("\n")}`;
	lines.splice(tokens, 0, ...block, "");
	return lines.join("\n");
}

/** A reload refreshes implementation closures, not stacks of permanent prototype wrappers. */
function patch<T extends object, K extends keyof T>(host: T, key: K, wrap: (original: T[K]) => T[K]): void {
	type Patched = T[K] & { [IMPLEMENTATION]?: T[K] };
	const slot = Symbol.for(`pi.session-time.patch.${String(key)}`);
	const installed = Reflect.get(host, slot) as Patched | undefined;
	const original = installed ?? host[key] as Patched;
	if (typeof original !== "function") throw new Error(`Pi's ${String(key)} API changed; update session-time`);
	if (installed) {
		Reflect.set(original, IMPLEMENTATION, wrap(Reflect.get(original, BASE_METHOD)));
		return;
	}
	const dispatch = function (this: unknown, ...args: unknown[]) {
		return Reflect.apply(dispatch[IMPLEMENTATION] as Function, this, args);
	} as unknown as Patched;
	dispatch[IMPLEMENTATION] = wrap(original);
	Object.defineProperty(dispatch, BASE_METHOD, { value: original });
	host[key] = dispatch;
	Reflect.set(host, slot, dispatch);
}

export function installPresentation(): void {
	const interactive = InteractiveMode.prototype as unknown as SessionHost;
	patch(interactive, "handleSessionCommand", (original) => function (this: SessionHost) {
		// Snapshot, like the rest of /session output.
		const summary = this.sessionManager[SUMMARY]?.();
		const start = this.chatContainer.children.length;
		original.call(this);
		if (!summary) return;
		for (const component of this.chatContainer.children.slice(start)) {
			const build = component.build;
			if (!build) continue;
			component.build = () => insertTime(build.call(component), summary);
			component.invalidate();
		}
	});
}
