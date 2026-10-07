import { stripVTControlCharacters } from "node:util";
import { FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { Summary } from "./ledger.ts";

export const SUMMARY = Symbol.for("pi.subagent-cost.summary");
// Optional presentation protocol shared with rmb-cost; neither extension imports the other.
export const FORMAT = Symbol.for("pi.cost.format-usd");
const IMPLEMENTATION = Symbol.for("pi.subagent-cost.implementation");
const BASE_METHOD = Symbol.for("pi.cost.base-method");
type SummarySource = { [SUMMARY]?: (reconcile?: boolean) => Summary };
interface FooterHost {
	session: { sessionManager: SummarySource };
	getSessionStats(): { usageTotals: { cost: number } };
}
interface TextComponent { build?: () => string; invalidate(): void }
interface SessionHost {
	sessionManager: SummarySource;
	session: { getSessionStats(): { cost: number } };
	chatContainer: { children: TextComponent[] };
	handleSessionCommand(): void;
}

function formatUSD(usd: number): string {
	const formatter = Reflect.get(FooterComponent.prototype, FORMAT) as ((usd: number) => string) | undefined;
	return formatter ? formatter(usd) : `$${usd.toFixed(3)}`;
}

/** Called on theme rebuilds too; input is generated /session text, never arbitrary chat. */
export function familyInfo(text: string, parent: number, children: Summary): string {
	if (!children.count) return text;
	const detail = `Parent: ${formatUSD(parent)}\nSubagents: ${formatUSD(children.costUSD)}\nTotal: ${formatUSD(parent + children.costUSD)}`;
	let inCost = false;
	let replaced = false;
	const result = text.split("\n").map((line) => {
		const plain = stripVTControlCharacters(line);
		if (plain === "Cost") inCost = true;
		else if (inCost && plain.startsWith("Total:")) { replaced = true; return detail; }
		return line;
	}).join("\n");
	// Pi omits the Cost section when the parent's own cost is zero.
	return replaced ? result : `${result.trimEnd()}\n\nCost\n${detail}`;
}

/** A reload refreshes implementation closures, not stacks of permanent prototype wrappers. */
function patch<T extends object, K extends keyof T>(host: T, key: K, wrap: (original: T[K]) => T[K]): void {
	type Patched = T[K] & { [IMPLEMENTATION]?: T[K] };
	const slot = Symbol.for(`pi.subagent-cost.patch.${String(key)}`);
	const installed = Reflect.get(host, slot) as Patched | undefined;
	const original = installed ?? host[key] as Patched;
	if (typeof original !== "function") throw new Error(`Pi's ${String(key)} API changed; update subagent-cost`);
	if (installed) {
		// The stable dispatch stores its original separately to refresh code on /reload.
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
	const footer = FooterComponent.prototype as unknown as FooterHost;
	patch(footer, "getSessionStats", (original) => function (this: FooterHost) {
		const stats = original.call(this);
		const children = this.session.sessionManager[SUMMARY]?.();
		return children?.count ? { ...stats, usageTotals: { ...stats.usageTotals, cost: stats.usageTotals.cost + children.costUSD } } : stats;
	});
	const interactive = InteractiveMode.prototype as unknown as SessionHost;
	patch(interactive, "handleSessionCommand", (original) => function (this: SessionHost) {
		const children = this.sessionManager[SUMMARY]?.(true);
		const parent = this.session.getSessionStats().cost;
		const start = this.chatContainer.children.length;
		original.call(this);
		if (!children?.count) return;
		for (const component of this.chatContainer.children.slice(start)) {
			const build = component.build;
			if (!build) continue;
			component.build = () => familyInfo(build.call(component), parent, children);
			component.invalidate();
		}
	});
}
