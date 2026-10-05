/**
 * The rewind checkpoint picker.
 *
 * A custom component instead of `ctx.ui.select`, because each checkpoint needs
 * several colored lines (prompt, totals, per-file stats) and the built-in
 * selector renders one uncolored line per option.
 *
 * pi-tui helpers are injected as `lib` so this module stays importable without
 * the runtime: the fake-runtime tests exercise it with lightweight stubs.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

export interface MenuFile {
	path: string;
	added: number;
	removed: number;
}

export interface MenuEntry {
	time: string;
	prompt: string | undefined;
	added: number;
	removed: number;
	files: MenuFile[];
}

export interface MenuLib {
	truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string;
}

const MAX_FILES_PER_ENTRY = 6;
const MIN_VISIBLE_ROWS = 6;
const MAX_VISIBLE_ROWS = 24;

function renderEntry(entry: MenuEntry, theme: Theme, width: number, lib: MenuLib, selected: boolean): string[] {
	const contentWidth = Math.max(1, width - 2);
	const marker = selected ? theme.fg("accent", "→ ") : "  ";
	const indent = selected ? theme.fg("accent", "│ ") : "  ";
	const total = `${theme.fg("toolDiffAdded", `+${entry.added}`)} ${theme.fg("toolDiffRemoved", `-${entry.removed}`)}`;
	const prompt = entry.prompt ? `"${entry.prompt}"` : theme.fg("muted", "(prompt unavailable)");
	const head = `${theme.fg("muted", entry.time)} ${selected ? theme.fg("accent", prompt) : prompt} ${total}`;
	const lines = [`${marker}${lib.truncateToWidth(head, contentWidth, "…")}`];
	const shown = entry.files.slice(0, MAX_FILES_PER_ENTRY);
	for (const file of shown) {
		const body = `${theme.fg("muted", file.path)} ${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `-${file.removed}`)}`;
		lines.push(`${indent}${lib.truncateToWidth(body, contentWidth, "…")}`);
	}
	if (entry.files.length > shown.length) {
		const more = theme.fg("dim", `… +${entry.files.length - shown.length} more files`);
		lines.push(`${indent}${lib.truncateToWidth(more, contentWidth, "…")}`);
	}
	return lines;
}

/** Resolve the selected checkpoint index, or undefined when the user cancels. */
export async function pickCheckpoint(
	ctx: ExtensionCommandContext,
	lib: MenuLib,
	entries: MenuEntry[],
): Promise<number | undefined> {
	return ctx.ui.custom<number | undefined>((tui, theme, kb, done) => {
		let selected = 0;
		let offset = 0;

		const move = (delta: number): void => {
			const next = Math.max(0, Math.min(entries.length - 1, selected + delta));
			if (next !== selected) {
				selected = next;
				tui.requestRender();
			}
		};

		return {
			invalidate() {},
			render(width: number): string[] {
				const rows = Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, tui.terminal.rows - 5));
				const blocks = entries.map((entry, index) => renderEntry(entry, theme, width, lib, index === selected));
				const offsets: number[] = [];
				let total = 0;
				for (const block of blocks) {
					offsets.push(total);
					total += block.length + 1; // one blank line between entries
				}
				const start = offsets[selected] ?? 0;
				const end = start + (blocks[selected]?.length ?? 0);
				if (start < offset) offset = start;
				if (end > offset + rows) offset = end - rows;
				offset = Math.max(0, Math.min(offset, Math.max(0, total - rows)));

				const flat: string[] = [];
				blocks.forEach((block, index) => {
					if (index > 0) flat.push("");
					flat.push(...block);
				});
				const window = flat.slice(offset, offset + rows);

				const hints = [
					`${kb.getKeys("tui.select.up").join("/") || "↑"}/${kb.getKeys("tui.select.down").join("/") || "↓"} navigate`,
					`${kb.getKeys("tui.select.confirm").join("/") || "enter"} select`,
					`${kb.getKeys("tui.select.cancel").join("/") || "esc"} cancel`,
				].join("  ");
				const title = `${theme.fg("accent", theme.bold("Rewind to which prompt?"))}  ${theme.fg("dim", hints)}`;
				return [lib.truncateToWidth(title, width, "…"), theme.fg("borderMuted", "─".repeat(width)), ...window];
			},
			handleInput(data: string): void {
				if (kb.matches(data, "tui.select.up")) move(-1);
				else if (kb.matches(data, "tui.select.down")) move(1);
				else if (kb.matches(data, "tui.select.pageUp")) move(-MIN_VISIBLE_ROWS);
				else if (kb.matches(data, "tui.select.pageDown")) move(MIN_VISIBLE_ROWS);
				else if (kb.matches(data, "tui.select.confirm")) done(selected);
				else if (kb.matches(data, "tui.select.cancel")) done(undefined);
			},
		};
	});
}
