import { keyText, truncateToVisualLines, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type JobAction = "start" | "watch" | "stop";
export interface JobResultDetails {
	id?: string;
	pid?: number;
	dir?: string;
	/** Display-only outcome supplied by execution, never inferred from a successful tool call. */
	summary?: string;
}

/** Width-aware five-line previews shared by tool results and notifications. */
export function jobPreview(text: string, theme: Theme, keep: "start" | "end"): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width) {
			if (cachedLines === undefined || cachedWidth !== width) {
				const { visualLines, skippedCount } = truncateToVisualLines(text, 5, width, 0, keep);
				const direction = keep === "end" ? "earlier" : "more";
				const hint = theme.fg("muted", `... (${skippedCount} ${direction} lines, `) +
					theme.fg("dim", keyText("app.tools.expand")) + theme.fg("muted", " to expand)");
				cachedLines = skippedCount > 0
					? keep === "end" ? [truncateToWidth(hint, width), ...visualLines] : [...visualLines, truncateToWidth(hint, width)]
					: visualLines;
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

function textArg(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function createJobToolRenderers(
	action: JobAction,
	options: {
		watchTimeoutSeconds?: (timeout: number | undefined) => number;
		jobName?: (id: string) => string | undefined;
	} = {},
): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const input = (args ?? {}) as { command?: unknown; name?: unknown; id?: unknown; timeout?: unknown; pattern?: unknown; signal?: unknown };
			const metadata: string[] = [];
			let title = `job ${action}`;
			if (action === "start") {
				const name = textArg(input.name);
				if (name) title += ` ${JSON.stringify(name)}`;
				if (typeof input.timeout === "number") metadata.push(`timeout ${input.timeout}s`);
			} else {
				const id = textArg(input.id);
				const state = context.state as { jobId?: string; jobName?: string };
				if (state.jobId !== id) {
					state.jobId = id;
					state.jobName = undefined;
				}
				const name = id ? textArg(options.jobName?.(id)) : undefined;
				if (name) state.jobName = name;
				title += ` ${id ?? "..."}${state.jobName ? ` ${JSON.stringify(state.jobName)}` : ""}`;
				if (action === "watch") {
					if (typeof input.pattern === "string") metadata.push(`/${input.pattern}/i`);
					const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
					const seconds = options.watchTimeoutSeconds ? options.watchTimeoutSeconds(timeout) : timeout;
					if (seconds !== undefined) metadata.push(`${seconds}s`);
				} else {
					metadata.push(textArg(input.signal) ?? "SIGTERM");
				}
			}
			let display = theme.fg("toolTitle", theme.bold(title));
			if (metadata.length) display += theme.fg("muted", ` · ${metadata.join(" · ")}`);
			if (action === "start") {
				const command = (textArg(input.command) ?? "...").replaceAll("\n", "\n  ");
				display += `\n${theme.fg("toolOutput", `  $ ${command}`)}`;
			}
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(display);
			return component;
		},
		renderResult(result, options, theme, context) {
			const content = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const details = result.details as JobResultDetails | undefined;
			let summary = content;
			if (!context.isError && !options.isPartial) {
				if (action === "start" && typeof details?.id === "string" && typeof details.pid === "number") {
					summary = `started ${details.id} · pgid ${details.pid}`;
				} else if (action === "watch" && typeof details?.id === "string") {
					summary = "watching";
				} else if (action === "stop" && typeof details?.summary === "string") {
					summary = details.summary;
				}
			}
			const output = options.expanded ? content : summary;
			const fallback = options.isPartial ? `${action === "start" ? "starting" : action === "watch" ? "watching" : "stopping"}...` : "(no output)";
			const styled = (output || fallback).split("\n").map((line, index) =>
				theme.fg(context.isError ? "error" : "toolOutput", `${index === 0 ? "→ " : "  "}${line}`),
			).join("\n");
			return options.expanded ? new Text(styled, 0, 0) : jobPreview(styled, theme, "start");
		},
	};
}
