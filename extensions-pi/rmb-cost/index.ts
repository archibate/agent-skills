/**
 * Convert Pi's terminal cost displays to RMB without changing USD accounting.
 * Footer/session/notices have no formatter hook, so their internal render paths
 * are patched narrowly. Codemode uses the supported tool-renderer middleware.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FooterComponent, InteractiveMode, getPackageDir, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { convertFooter, convertNotice, convertSessionInfo, formatRmb, type SessionCosts } from "./format.ts";

const PATCHED = Symbol.for("pi.rmb-cost.terminal-patched");
const LEGACY_PATCHED = Symbol.for("pi.rmb-cost.patched");
const CONVERTER = Symbol.for("pi.rmb-cost.converter");
const BASE_RENDER = Symbol.for("pi.rmb-cost.base-render");
const RMB_RENDER = Symbol.for("pi.rmb-cost.rmb-render");
type PatchedFunction = { [PATCHED]?: boolean };
type FooterRenderer = typeof FooterComponent.prototype.render & PatchedFunction & {
	[BASE_RENDER]?: typeof FooterComponent.prototype.render;
	[RMB_RENDER]?: typeof FooterComponent.prototype.render;
};
interface BuiltText extends Component { build?: () => string }
interface CostHost {
	chatContainer: { children: BuiltText[] };
	session: {
		getSessionStats(): { cost: number };
		cacheWarmingStatus?: { decision?: SessionCosts["decision"] };
		modelRuntime: unknown;
	};
	sessionManager: { getEntries(): unknown[] };
}
type NoticeMethod = ((this: CostHost, ...args: any[]) => unknown) & PatchedFunction & { [CONVERTER]?: ConverterFactory };
type ConverterFactory = (host: CostHost, args: any[]) => (text: string) => string;
interface CostHelpers {
	computeCacheWaste(entries: unknown[], models: unknown): { missedCost: number };
	getUsageCostBreakdown(entries: unknown[]): { key: string; cost: number }[];
}
interface FooterHost {
	getSessionStats(): { usageTotals: { cost: number } };
	session: {
		state: { model?: { provider: string } };
		modelRuntime: { isUsingSubscription(provider: string): boolean };
	};
}

function patchNoticeMethod(proto: Record<string, NoticeMethod | undefined>, name: string, makeConverter: ConverterFactory): void {
	const original = proto[name];
	if (!original) return;
	if (original[PATCHED]) {
		original[CONVERTER] = makeConverter;
		return;
	}
	const patched: NoticeMethod = function (...args) {
		const convert = patched[CONVERTER]!(this, args);
		const children = this.chatContainer.children;
		const start = children.length;
		const result = original.apply(this, args);
		// Only the ThemedText instances appended by this specific display method.
		// Conversion happens inside build(), before wrapping, and survives theme changes.
		for (const component of children.slice(start)) {
			const build = component.build;
			if (typeof build !== "function") continue;
			component.build = () => convert(build.call(component));
			component.invalidate();
		}
		return result;
	};
	patched[PATCHED] = true;
	patched[CONVERTER] = makeConverter;
	proto[name] = patched;
}

function createFooterRenderer(original: typeof FooterComponent.prototype.render): typeof original {
	return function (this: FooterComponent, width) {
		const host = this as unknown as FooterHost;
		const stats = host.getSessionStats();
		const usd = stats.usageTotals.cost;
		const model = host.session.state.model;
		const subscription = model && (model.provider === "kimi-coding" || host.session.modelRuntime.isUsingSubscription(model.provider));
		// A detached presentation-only view. Numeric coercion remains USD; only the
		// cost's toFixed() provides RMB digits to upstream *before* width/layout.
		const cost = usd || subscription
			? Object.assign(new Number(usd), { toFixed: () => formatRmb(usd).replace("¥", "") })
			: usd;
		const view = Object.create(this) as FooterHost;
		view.getSessionStats = () => ({ ...stats, usageTotals: { ...stats.usageTotals, cost: cost as unknown as number } });
		const lines = original.call(view as unknown as FooterComponent, width).slice();
		if (lines[1]) lines[1] = convertFooter(lines[1]);
		return lines;
	};
}

function patchTerminalCosts(helpers: CostHelpers): boolean {
	const footer = FooterComponent.prototype;
	const original = footer.render as FooterRenderer;
	const legacyFooter = Reflect.get(footer, LEGACY_PATCHED) === true && !original[PATCHED];
	// Keep one stable wrapper, but refresh its implementation/formatter on every /reload.
	if (original[PATCHED] && original[BASE_RENDER]) {
		original[RMB_RENDER] = createFooterRenderer(original[BASE_RENDER]);
	} else if (!original[PATCHED] && !legacyFooter) {
		const patched: FooterRenderer = function (this: FooterComponent, width) {
			return patched[RMB_RENDER]!.call(this, width);
		};
		patched[PATCHED] = true;
		patched[BASE_RENDER] = original;
		patched[RMB_RENDER] = createFooterRenderer(original);
		footer.render = patched;
	}
	// The old wrapper hides its original renderer in a closure; it requires one restart.
	const proto = InteractiveMode.prototype as unknown as Record<string, NoticeMethod | undefined>;
	patchNoticeMethod(proto, "handleSessionCommand", (host) => {
		const entries = host.sessionManager.getEntries();
		const costs: SessionCosts = {
			total: host.session.getSessionStats().cost,
			models: new Map(helpers.getUsageCostBreakdown(entries).map((entry) => [entry.key, entry.cost])),
			missed: helpers.computeCacheWaste(entries, host.session.modelRuntime).missedCost,
			decision: host.session.cacheWarmingStatus?.decision && { ...host.session.cacheWarmingStatus.decision },
		};
		return (text) => convertSessionInfo(text, costs);
	});
	for (const name of ["addCacheWarmingUsage", "addCompactionCostNotice", "addCacheMissNotice"]) {
		patchNoticeMethod(proto, name, (_host, [notice]) => {
			const usd = name === "addCacheMissNotice" ? notice.missedCost : notice.usage.cost.total;
			return (text) => convertNotice(text, usd);
		});
	}
	return legacyFooter;
}

function registerCodemodeCosts(pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next): ToolRenderers | undefined => {
		const base = next();
		if (name !== "codemode" || !base?.renderResult) return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const calls = result.details?.calls ?? [];
				const shown = options.expanded ? calls : calls.slice(-8);
				const total = calls.reduce((sum: number, call: { cost?: number }) => sum + (call.cost ?? 0), 0);
				let callIndex = 0;
				let currentCost: number | undefined;
				let pendingArgs = false;
				// Keep the renderer's layout/reuse. Price metadata is dim; args are muted
				// and must pass through even when they say "Model calls: $...".
				const costTheme = Object.create(theme) as typeof theme;
				costTheme.fg = (color, text) => {
					if (color === "toolTitle") {
						const call = shown[callIndex++];
						currentCost = call?.name === text ? call.cost : undefined;
						pendingArgs = Boolean(call?.args);
					}
					if (color === "muted" && pendingArgs) {
						pendingArgs = false;
						return theme.fg(color, text);
					}
					if (color === "dim" && currentCost !== undefined && /^\$[\d.e+-]+$/i.test(text)) {
						text = formatRmb(currentCost);
						currentCost = undefined;
					} else if (color === "muted" && callIndex === shown.length && total && /^Model calls: \$[\d.e+-]+$/i.test(text)) {
						text = `Model calls: ${formatRmb(total)}`;
					}
					return theme.fg(color, text);
				};
				return renderResult(result, options, costTheme, context);
			},
		};
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// Reuse Pi's own accounting algorithms for the /session presentation snapshot.
	// These internal helpers ship with the Node distribution, like the patched renderers.
	const core = join(getPackageDir(), "dist", "core");
	const [cache, usage] = await Promise.all([
		import(pathToFileURL(join(core, "cache-stats.js")).href),
		import(pathToFileURL(join(core, "usage-totals.js")).href),
	]);
	const legacyFooter = patchTerminalCosts({ computeCacheWaste: cache.computeCacheWaste, getUsageCostBreakdown: usage.getUsageCostBreakdown });
	registerCodemodeCosts(pi); // Extension-runtime registrations must return on every /reload.
	if (legacyFooter) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify("rmb-cost: restart Pi once to replace the old footer patch.", "warning");
		});
	}
}
