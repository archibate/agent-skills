/**
 * /context - visualize how the model's context window is being used.
 *
 * Breaks the next request into the categories Claude Code's /context shows:
 * system prompt, project context files, skills, tool definitions, MCP tools,
 * conversation messages, and summaries - plus free space.
 *
 * Counting:
 * - The used total comes from ctx.getContextUsage(), which can combine provider
 *   usage with estimates, or be unknown after compaction.
 * - Retained messages are split into user, assistant (reasoning/text/tool calls),
 *   tool results, other, and summaries. Counts use pi's chars/4 estimator and
 *   reconcile recursively with the used total. The split stays approximate;
 *   hidden reasoning and opaque signatures cannot be recovered or counted.
 *
 * Usage:
 *   /context          show the breakdown and top five call/result tool names
 *   /context tools    show all call/result tools and tool definitions
 *   /context skills   include the per-skill detail
 *   /context all      include both (aliases: verbose, -v)
 *
 * The overlay scrolls with arrows/PageUp/PageDown/Home/End and closes with
 * Esc, Enter, q, or Ctrl+C.
 */

import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

type EstimatableMessage = Parameters<typeof estimateTokens>[0];

/**
 * Count an arbitrary prompt fragment (system section, tool schema, skill
 * blurb) with pi's own chars/4 estimator, by wrapping it as a user message.
 * This keeps every number in the report on the same scale as whole messages.
 */
function textTokens(text: string | undefined | null): number {
	if (!text) return 0;
	return estimateTokens({ role: "user", content: text } as EstimatableMessage);
}

function safeJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function countMessage(message: unknown): number {
	return estimateTokens(message as EstimatableMessage);
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

interface Stat {
	label: string;
	tokens: number;
	color: ThemeColor;
	children?: Stat[];
	/** Children belong in a separate per-tool detail section, not the overview. */
	detail?: "calls" | "results";
}

interface DetailItem {
	label: string;
	tokens: number;
}

interface ContextReport {
	modelLabel: string;
	window: number;
	used: number;
	usedKnown: boolean;
	free: number;
	stats: Stat[];
	files: DetailItem[];
	skills: DetailItem[];
	tools: DetailItem[];
	showSkills: boolean;
	showTools: boolean;
}

const COLORS: Record<string, ThemeColor> = {
	system: "accent",
	context: "success",
	skills: "mdLink",
	tools: "syntaxFunction",
	mcp: "syntaxVariable",
	messages: "toolOutput",
	user: "userMessageText",
	assistant: "mdHeading",
	toolResults: "toolOutput",
	other: "customMessageLabel",
	summary: "syntaxString",
};

// ---------------------------------------------------------------------------
// Conversation accounting
// ---------------------------------------------------------------------------

type Projection = { entries: Array<{ messages: readonly EstimatableMessage[] }> };

/** Allocate integer totals recursively, preserving every parent/child sum. */
export function allocateStats(stats: Stat[], total: number): Stat[] {
	const allocations = segmentWidths(stats.map((stat) => stat.tokens), total);
	return stats.map((stat, index) => ({
		...stat,
		tokens: allocations[index]!,
		children: stat.children && allocateStats(stat.children, allocations[index]!),
	}));
}

function group(label: string, color: ThemeColor, children: Stat[], detail?: Stat["detail"]): Stat {
	return { label, color, tokens: children.reduce((sum, child) => sum + child.tokens, 0), children, detail };
}

function addTool(tools: Map<string, number>, name: string, tokens: number): void {
	tools.set(name, (tools.get(name) ?? 0) + tokens);
}

function toolStats(tools: Map<string, number>, color: ThemeColor): Stat[] {
	return [...tools].sort(([a], [b]) => compareNames(a, b))
		.map(([label, tokens]) => ({ label, tokens, color }));
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function collectConversation(projection: Projection): Stat {
	let user = 0;
	let reasoning = 0;
	let text = 0;
	let other = 0;
	let summaries = 0;
	const calls = new Map<string, number>();
	const results = new Map<string, number>();

	// Only projected messages contribute: no abandoned/compacted history or
	// nested execution metadata. Historical tool names need not still be active.
	for (const entry of projection.entries) {
		for (const message of entry.messages) {
			const tokens = countMessage(message);
			switch (message.role) {
				case "user": user += tokens; break;
				case "assistant": {
					let thinkingChars = 0;
					let textChars = 0;
					const callChars = new Map<string, number>();
					for (const block of message.content) {
						if (block.type === "thinking") thinkingChars += block.thinking.length;
						else if (block.type === "text") textChars += block.text.length;
						else if (block.type === "toolCall") {
							addTool(callChars, block.name, block.name.length + safeJson(block.arguments).length);
						}
					}
					// Match Pi's whole-message ceil(chars/4), rather than rounding
					// every block separately. Signatures and usage are not content.
					const split = allocateStats([
						{ label: "Reasoning", tokens: thinkingChars, color: COLORS.assistant },
						{ label: "Text", tokens: textChars, color: COLORS.assistant },
						group("Tool calls", COLORS.tools, toolStats(callChars, COLORS.tools)),
					], tokens);
					reasoning += split[0]!.tokens;
					text += split[1]!.tokens;
					for (const call of split[2]!.children!) addTool(calls, call.label, call.tokens);
					break;
				}
				case "toolResult": addTool(results, message.toolName, tokens); break;
				case "bashExecution":
				case "custom": other += tokens; break;
				case "branchSummary":
				case "compactionSummary": summaries += tokens; break;
			}
		}
	}

	const assistant = group("Assistant", COLORS.assistant, [
		{ label: "Reasoning", tokens: reasoning, color: COLORS.assistant },
		{ label: "Text", tokens: text, color: COLORS.assistant },
		group("Tool calls", COLORS.tools, toolStats(calls, COLORS.tools), "calls"),
	].filter((stat) => stat.tokens > 0));
	return group("Messages", COLORS.messages, [
		{ label: "User", tokens: user, color: COLORS.user },
		assistant,
		group("Tool results", COLORS.toolResults, toolStats(results, COLORS.toolResults), "results"),
		{ label: "Other", tokens: other, color: COLORS.other },
		{ label: "Summaries", tokens: summaries, color: COLORS.summary },
	].filter((stat) => stat.tokens > 0));
}

/** Select only after allocation; the remainder therefore reconciles exactly. */
export function rankTools(items: DetailItem[], limit: number): DetailItem[] {
	const ranked = [...items].sort((a, b) => b.tokens - a.tokens || compareNames(a.label, b.label));
	if (ranked.length <= limit) return ranked;
	return [...ranked.slice(0, limit), {
		label: "Other tools",
		tokens: ranked.slice(limit).reduce((sum, item) => sum + item.tokens, 0),
	}];
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface CollectedSystem {
	systemTokens: number;
	contextTokens: number;
	skillsTokens: number;
}

function collectSystemSections(
	ctx: ExtensionCommandContext,
	opts: BuildSystemPromptOptions,
	projection: { entries: Array<{ messages: readonly unknown[] }> },
): CollectedSystem {
	const sections = new Map<string, number>();

	// Prefer the enriched system message(s) the transcript actually carries:
	// buildSystemPromptSections() is not exported, but the persisted sections
	// are exact, including run-time extensions and compaction checkpoints.
	for (const projected of projection.entries) {
		for (const raw of projected.messages) {
			const message = raw as { role?: string; content?: unknown; sections?: unknown };
			if (message.role !== "system") continue;
			if (typeof message.content === "string") {
				sections.set(
					"__content",
					(sections.get("__content") ?? 0) + textTokens(message.content),
				);
			}
			if (message.sections && typeof message.sections === "object") {
				for (const [name, text] of Object.entries(message.sections as Record<string, unknown>)) {
					if (typeof text === "string" && text) {
						sections.set(name, (sections.get(name) ?? 0) + textTokens(text));
					}
				}
			}
		}
	}

	if (sections.size === 0) {
		// Fresh session: no transcript system message yet. Reconstruct the
		// split from the prompt options and the rendered prompt text.
		const full = textTokens(ctx.getSystemPrompt());
		const contextFiles = opts.contextFiles ?? [];
		const skillList = opts.skills ?? [];
		const fileTotal = contextFiles.reduce(
			(sum, file) => sum + textTokens(file.content) + textTokens(file.path) + 40,
			0,
		);
		const readTool = opts.selectedTools?.includes("bash") ? "bash" : "read";
		const skillTotal = skillList.length
			? textTokens(formatSkillsForPrompt(skillList, readTool))
			: 0;
		if (fileTotal > 0 || skillTotal > 0) {
			const base = Math.max(0, full - fileTotal - skillTotal);
			if (base > 0) sections.set("preamble", base);
			if (fileTotal > 0) sections.set("project_context", fileTotal);
			if (skillTotal > 0) sections.set("skills", skillTotal);
		} else if (full > 0) {
			sections.set("preamble", full);
		}
	}

	let systemTokens = 0;
	let contextTokens = 0;
	let skillsTokens = 0;
	for (const [name, tokens] of sections) {
		if (name === "project_context") contextTokens += tokens;
		else if (name === "skills") skillsTokens += tokens;
		else systemTokens += tokens;
	}
	return { systemTokens, contextTokens, skillsTokens };
}

export async function collectReport(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	showSkills: boolean,
	showTools: boolean,
): Promise<ContextReport> {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const window =
		usage?.contextWindow ?? (model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
	const opts = ctx.getSystemPromptOptions();
	const projection = ctx.sessionManager.buildSessionProjection();
	const system = collectSystemSections(ctx, opts, projection);

	// Context files and skills detail come from the live options.
	const files: DetailItem[] = (opts.contextFiles ?? []).map((file) => ({
		label: file.path,
		tokens: textTokens(file.content) + textTokens(file.path) + 40,
	}));
	const skills: DetailItem[] = (opts.skills ?? []).map((skill) => ({
		label: skill.name,
		tokens: textTokens(skill.description) + textTokens(skill.filePath) + 20,
	}));

	// Tool declarations: description and parameter schema are sent separately
	// from the one-line snippets that live in the system prompt.
	const active = new Set(pi.getActiveTools());
	const tools: DetailItem[] = [];
	let builtinToolTokens = 0;
	let mcpToolTokens = 0;
	for (const tool of pi.getAllTools()) {
		if (!active.has(tool.name)) continue;
		const tokens =
			textTokens(tool.name) +
			textTokens(tool.description) +
			textTokens(safeJson(tool.parameters)) +
			16; // declaration wrapper overhead
		const isMcp = Boolean(tool.namespace);
		tools.push({ label: tool.name, tokens });
		if (isMcp) mcpToolTokens += tokens;
		else builtinToolTokens += tokens;
	}
	tools.sort((a, b) => b.tokens - a.tokens);

	const messages = collectConversation(projection);

	const raw: Stat[] = [];
	const add = (label: string, tokens: number, color: ThemeColor, children?: Stat[]) => {
		if (tokens > 0) raw.push({ label, tokens, color, children });
	};

	add("System prompt", system.systemTokens, COLORS.system);
	add("Context files", system.contextTokens, COLORS.context);
	add("Skills", system.skillsTokens, COLORS.skills);
	add("Tool definitions", builtinToolTokens, COLORS.tools);
	add("MCP tool definitions", mcpToolTokens, COLORS.mcp);
	if (messages.tokens > 0) raw.push(messages);

	const estimated = raw.reduce((sum, stat) => sum + stat.tokens, 0);
	const usedKnown = usage?.tokens != null;
	const used = usage?.tokens ?? estimated;
	// A known positive total with no estimatable content cannot be attributed.
	if (estimated === 0 && used > 0) add("Unattributed", used, COLORS.other);
	const stats = allocateStats(raw, used);

	const modelLabel = model ? `${model.provider}/${model.id}` : "no model selected";

	return {
		modelLabel,
		window,
		used,
		usedKnown,
		free: Math.max(0, window - used),
		stats,
		files,
		skills,
		tools,
		showSkills,
		showTools,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Palette {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	swatch(color: ThemeColor): string;
}

function themePalette(theme: Theme): Palette {
	return {
		fg: (color, text) => theme.fg(color, text),
		bold: (text) => theme.bold(text),
		swatch: (color) => theme.fg(color, "■"),
	};
}

const plainPalette: Palette = {
	fg: (_color, text) => text,
	bold: (text) => text,
	swatch: (_color) => "•",
};

function fmtTokens(value: number): string {
	const n = Math.max(0, Math.round(value));
	if (n < 1000) return String(n);
	if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function fmtPercent(tokens: number, window: number): string {
	if (window <= 0) return "—";
	return `${((tokens / window) * 100).toFixed(1)}%`;
}

function truncateLeft(text: string, max: number): string {
	if (max <= 0) return "";
	const width = visibleWidth(text);
	if (width <= max) return text;
	return `…${sliceByColumn(text, width - max + 1, max - 1, true)}`;
}

function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Largest-remainder widths so the stacked bar fills exactly `width` cells. */
function segmentWidths(tokens: number[], width: number): number[] {
	const total = tokens.reduce((sum, value) => sum + Math.max(0, value), 0);
	if (total <= 0 || width <= 0) return tokens.map(() => 0);
	const exact = tokens.map((value) => (Math.max(0, value) / total) * width);
	const widths = exact.map((value) => Math.floor(value));
	const leftover = width - widths.reduce((sum, value) => sum + value, 0);
	const order = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((a, b) => b.fraction - a.fraction);
	for (let i = 0; i < leftover; i++) {
		const index = order[i % order.length]!.index;
		widths[index] = (widths[index] ?? 0) + 1;
	}
	return widths;
}

function renderBar(report: ContextReport, palette: Palette, width: number): string {
	const segments = [...report.stats, { label: "Free", color: "dim" as ThemeColor, tokens: report.free }];
	const widths = segmentWidths(
		segments.map((segment) => segment.tokens),
		width,
	);
	let out = "";
	for (let i = 0; i < segments.length; i++) {
		const cells = widths[i]!;
		if (cells <= 0) continue;
		const free = i === segments.length - 1;
		out += palette.fg(segments[i]!.color, (free ? "░" : "█").repeat(cells));
	}
	return out;
}

export function renderLines(report: ContextReport, palette: Palette, width: number): string[] {
	const lines: string[] = [];
	const push = (text = "") => lines.push(truncateToWidth(text, width, "…", true));

	push();
	push(`  ${palette.bold("Context usage")}`);
	push();

	if (report.window <= 0) {
		push(`  ${palette.fg("warning", "No context window available (no model selected).")}`);
		return lines;
	}

	push(
		`  ${palette.bold(report.modelLabel)}  ${palette.fg("dim", `·  ${fmtTokens(report.window)} window`)}`,
	);
	push(
		`  ${palette.fg("accent", fmtTokens(report.used))} used  ` +
			`${palette.fg("dim", `(${fmtPercent(report.used, report.window)})`)}` +
			`  ${palette.fg("dim", "·")}  ${fmtTokens(report.free)} free`,
	);
	push();
	push(`  ${renderBar(report, palette, Math.max(1, width - 4))}`);
	push();

	const legendRow = (swatch: string, label: string, tokens: number, depth: number) => {
		const numbers = `${fmtTokens(tokens).padStart(7)}  ${fmtPercent(tokens, report.window).padStart(6)}`;
		// Reserve numeric columns first. Truncate the complete label field so
		// nesting never shifts numbers or clips percentages at narrow widths.
		const labelWidth = Math.max(0, width - visibleWidth(numbers) - 2);
		const prefix = width < 40 ? " ".repeat(depth + 1) : `${"  ".repeat(depth + 1)}${swatch} `;
		const name = truncateToWidth(`${prefix}${label}`, labelWidth, "…");
		return `${padVisible(name, labelWidth)}${numbers}`;
	};

	const toolDetails: Stat[] = [];
	const overview = (stats: Stat[], depth: number) => {
		for (const stat of stats) {
			push(legendRow(palette.swatch(stat.color), stat.label, stat.tokens, depth));
			if (stat.detail) toolDetails.push(stat);
			else overview(stat.children ?? [], depth + 1);
		}
	};
	overview(report.stats, 0);
	if (report.free > 0) {
		push(legendRow(palette.fg("dim", "░"), "Free", report.free, 0));
	}

	const detail = (title: string, items: DetailItem[], color: ThemeColor, limit: number) => {
		if (items.length === 0) return;
		push();
		push(`  ${palette.fg(color, title)}`);
		for (const item of items.slice(0, limit)) {
			const numbers = fmtTokens(item.tokens).padStart(7);
			const labelWidth = Math.max(0, width - visibleWidth(numbers) - 6);
			const name = truncateLeft(item.label, labelWidth);
			push(`    ${padVisible(name, labelWidth)}${numbers}`);
		}
		if (items.length > limit) {
			push(`    ${palette.fg("dim", `… +${items.length - limit} more`)}`);
		}
	};

	detail(`Context files (${report.files.length})`, report.files, COLORS.context, 20);
	if (report.showSkills) {
		detail(`Skills (${report.skills.length})`, report.skills, COLORS.skills, 20);
	}
	if (report.showTools) {
		detail(`Tool definitions (${report.tools.length})`, report.tools, COLORS.tools, 24);
	}
	for (const stat of toolDetails) {
		const items = stat.children ?? [];
		detail(`${stat.label} (${items.length})`, rankTools(items, report.showTools ? Infinity : 5), stat.color, Infinity);
	}

	push();
	push(`  ${palette.fg("dim", "Split with pi's chars/4 estimate.")}`);
	push(
		`  ${palette.fg(
			"dim",
			report.usedKnown
				? "Scaled to Pi's context total (usage + estimates); split is approximate."
				: "Context usage unknown; raw chars/4 estimates.",
		)}`,
	);
	return lines;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

class ContextView implements Component {
	constructor(
		private readonly report: ContextReport,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return renderLines(this.report, themePalette(this.theme), width);
	}

	invalidate(): void {}
}

function openPager(ctx: ExtensionCommandContext, report: ContextReport): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const body = new ContextView(report, theme);
		let offset = 0;
		let lastCount = 0;

		const viewportRows = () => Math.max(6, Math.floor(tui.terminal.rows * 0.8));
		const contentRows = () => Math.max(1, viewportRows() - 1);

		return {
			render(width: number): string[] {
				const lines = body.render(width);
				lastCount = lines.length;
				const rows = contentRows();
				const maxOffset = Math.max(0, lines.length - rows);
				if (offset > maxOffset) offset = maxOffset;
				const visible = lines.slice(offset, offset + rows);
				while (visible.length < rows) visible.push(truncateToWidth("", width, "…", true));

				const first = lines.length > 0 ? offset + 1 : 0;
				const last = Math.min(offset + rows, lines.length);
				const hint =
					lines.length > rows
						? `${first}-${last}/${lines.length}  ·  ↑↓ scroll  ·  Esc close`
						: "Esc close";
				visible.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width, "…", true));
				return visible;
			},
			invalidate(): void {
				body.invalidate();
			},
			handleInput(data: string): void {
				if (
					matchesKey(data, "escape") ||
					matchesKey(data, "return") ||
					matchesKey(data, "q") ||
					matchesKey(data, "ctrl+c")
				) {
					done();
					return;
				}
				let next = offset;
				if (matchesKey(data, "up")) next = offset - 1;
				else if (matchesKey(data, "down")) next = offset + 1;
				else if (matchesKey(data, "pageUp")) next = offset - contentRows();
				else if (matchesKey(data, "pageDown")) next = offset + contentRows();
				else if (matchesKey(data, "home")) next = 0;
				else if (matchesKey(data, "end")) next = Number.MAX_SAFE_INTEGER;
				else return;

				const rows = contentRows();
				offset = Math.max(0, Math.min(Math.max(0, lastCount - rows), next));
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center", margin: 1 },
	});
}

export default function contextExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show how the model's context window is being used",
		handler: async (args, ctx) => {
			try {
				const flags = (args ?? "").toLowerCase();
				const all = /\b(all|verbose)\b|-v\b/.test(flags);
				const report = await collectReport(
					ctx,
					pi,
					all || /\bskills\b/.test(flags),
					all || /\btools\b/.test(flags),
				);

				if (ctx.mode === "tui") {
					await openPager(ctx, report);
					return;
				}

				const text = renderLines(report, plainPalette, 100).join("\n");
				if (ctx.hasUI) {
					await ctx.ui.editor("Context usage", text);
				} else {
					console.log(text);
				}
			} catch (error) {
				ctx.ui.notify(`/context failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
