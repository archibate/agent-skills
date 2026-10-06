/**
 * The manual reviewer's modal: what the call does, what it needs beyond the allowance, and
 * yes / always / no / no-with-feedback. Keys are ignored for ARM_DELAY_MS after it opens, so a key
 * pressed while typing, just as the modal appears, does not answer it.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ReviewRequest, Verdict } from "./review.ts";

export const ARM_DELAY_MS = 300;
const PREVIEW_LINES = 24;

type Paint = Pick<Theme, "fg" | "bold">;

function clip(lines: string[], limit: number, theme: Paint): string[] {
	if (lines.length <= limit) return lines;
	return [...lines.slice(0, limit), theme.fg("dim", `… ${lines.length - limit} more lines`)];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** What the call would do: the command, the edit diff, or the written file. */
export function previewLines(request: ReviewRequest, theme: Paint): string[] {
	const { input } = request;
	if (request.toolName === "bash" || request.toolName === "job_start") {
		const lines = text(input.command).split("\n");
		return clip(
			lines.map((line, i) => theme.fg("toolTitle", `${i === 0 ? "$" : " "} ${line}`)),
			PREVIEW_LINES,
			theme,
		);
	}
	if (request.toolName === "edit") {
		const lines = [theme.fg("muted", `edit ${text(input.path)}`)];
		const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
		for (const edit of edits) {
			for (const line of text(edit.oldText).split("\n")) lines.push(theme.fg("toolDiffRemoved", `- ${line}`));
			for (const line of text(edit.newText).split("\n")) lines.push(theme.fg("toolDiffAdded", `+ ${line}`));
		}
		return clip(lines, PREVIEW_LINES, theme);
	}
	if (request.toolName === "write") {
		const path = text(input.path);
		const action = existsSync(resolve(request.cwd, path)) ? "overwrite" : "create";
		const lines = [theme.fg("muted", `${action} ${path}`)];
		for (const line of text(input.content).split("\n")) lines.push(theme.fg("toolDiffAdded", `+ ${line}`));
		return clip(lines, PREVIEW_LINES, theme);
	}
	return clip(JSON.stringify(input, null, 2).split("\n").map((line) => theme.fg("toolOutput", line)), PREVIEW_LINES, theme);
}

export class ReviewModal implements Component {
	private readonly tui: Pick<TUI, "requestRender">;
	private readonly theme: Paint;
	private readonly request: ReviewRequest;
	private readonly done: (verdict: Verdict | "feedback") => void;
	private readonly now: () => number;
	private readonly openedAt: number;
	private armed = false;
	private readonly armTimer: ReturnType<typeof setTimeout>;
	private finished = false;

	constructor(
		tui: Pick<TUI, "requestRender">,
		theme: Paint,
		request: ReviewRequest,
		done: (verdict: Verdict | "feedback") => void,
		now: () => number = Date.now,
	) {
		this.tui = tui;
		this.theme = theme;
		this.request = request;
		this.done = done;
		this.now = now;
		this.openedAt = now();
		this.armTimer = setTimeout(() => {
			this.armed = true;
			this.tui.requestRender();
		}, ARM_DELAY_MS);
	}

	private finish(verdict: Verdict | "feedback"): void {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.armTimer);
		this.done(verdict);
	}

	handleInput(data: string): void {
		if (this.now() - this.openedAt < ARM_DELAY_MS) return;
		if (matchesKey(data, Key.enter) || data === "y" || data === "Y") this.finish({ kind: "approve" });
		else if ((data === "a" || data === "A") && this.request.always) this.finish({ kind: "always" });
		else if (matchesKey(data, Key.escape) || data === "n" || data === "N") this.finish({ kind: "deny" });
		else if (data === "f" || data === "F") this.finish("feedback");
	}

	render(width: number): string[] {
		const { theme, request } = this;
		const inner = Math.max(10, width - 2);
		const out: string[] = [];
		const push = (line: string) => out.push(truncateToWidth(` ${line}`, width));
		const title = ` Permission request · ${request.subject} `;
		const rule = (head = "") => truncateToWidth(head + theme.fg("borderAccent", "─".repeat(width)), width, "");
		out.push(rule(theme.fg("borderAccent", "──") + theme.fg("accent", theme.bold(title))));
		if (request.reviewerFeedback) {
			push(theme.fg("warning", "Automatic review:"));
			for (const line of clip(wrapTextWithAnsi(theme.fg("muted", request.reviewerFeedback), inner), 6, theme)) push(line);
			out.push("");
		}
		for (const line of previewLines(request, theme)) for (const wrapped of wrapTextWithAnsi(line, inner)) push(wrapped);
		out.push("");
		push(theme.fg("muted", "Needs, beyond this session's permissions:"));
		for (const grant of request.excess) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("warning", `⚠ ${grant}`), inner - 2)) push(`  ${wrapped}`);
		}
		out.push("");
		const key = (k: string, label: string) =>
			this.armed ? `${theme.fg("accent", theme.bold(k))} ${label}` : theme.fg("dim", `${k} ${label}`);
		const keys = [key("enter/y", "yes")];
		if (request.always) keys.push(key("a", "always"));
		keys.push(key("esc/n", "no"), key("f", "no, with feedback"));
		for (const wrapped of wrapTextWithAnsi(keys.join(theme.fg("dim", "  ·  ")), inner)) push(wrapped);
		if (request.always) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("dim", `always adds to this session: ${request.always}`), inner)) push(wrapped);
		}
		out.push(rule());
		return out;
	}

	invalidate(): void {}

	dispose(): void {
		clearTimeout(this.armTimer);
	}
}
