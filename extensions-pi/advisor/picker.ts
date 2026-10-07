import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList, Text, truncateToWidth, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";

export interface AdvisorChoice { model: string | null; save: boolean }
export interface PickerOptions { main: string; models: readonly Model<Api>[]; current?: string; saved?: string | null; query?: string }
const visible = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, " ");

/** Snapshot-only picker: no discovery, credentials, timers, or inference. */
export class AdvisorPicker implements Component, Focusable {
	private readonly input = new Input();
	private readonly items: SelectItem[];
	private list!: SelectList;
	private closed = false;
	private readonly tui: Pick<TUI, "requestRender">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (choice: AdvisorChoice | undefined) => void;
	private readonly options: PickerOptions;
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(tui: Pick<TUI, "requestRender">, theme: Theme, keys: KeybindingsManager,
		done: (choice: AdvisorChoice | undefined) => void, options: PickerOptions) {
		this.tui = tui; this.theme = theme; this.keys = keys; this.done = done; this.options = options;
		const badge = (model: string | null) => [model === (options.current ?? null) ? "current" : "", model === options.saved ? "saved" : ""].filter(Boolean).join(" · ");
		this.items = [{ value: "none", label: "None", description: ["Disable advisor", badge(null)].filter(Boolean).join(" · ") },
			...options.models.filter((m) => m.api !== "pi-virtual").map((model) => {
				const id = `${model.provider}/${model.id}`;
				return { value: id, label: visible(model.id), description: [`[${visible(model.provider)}] ${visible(model.name)}`, badge(id)].filter(Boolean).join(" · ") };
			}).sort((a, b) => a.value.localeCompare(b.value))];
		this.input.setValue(options.query ?? "");
		this.filter();
	}
	private filter(): void {
		const query = this.input.getValue();
		const items = query ? fuzzyFilter(this.items, query, (item) => `${item.label} ${item.description}`) : this.items;
		this.list = new SelectList(items, 8, {
			selectedPrefix: (text) => this.theme.fg("accent", text), selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text), scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: () => this.theme.fg("muted", "  No matching models"),
		}, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 60, truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…") });
		if (!query) this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === (this.options.current ?? "none"))));
	}
	private finish(save: boolean): void {
		const item = this.list.getSelectedItem();
		if (!item) return;
		this.closed = true;
		this.done({ model: item.value === "none" ? null : item.value, save });
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "app.models.save")) this.finish(true);
		else if (this.keys.matches(data, "tui.select.confirm")) this.finish(false);
		else if (this.keys.matches(data, "tui.select.cancel")) { this.closed = true; this.done(undefined); }
		else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")) this.list.handleInput(data);
		else { const before = this.input.getValue(); this.input.handleInput(data); if (this.input.getValue() !== before) this.filter(); }
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const hint = ([ ["tui.select.confirm", "session"], ["app.models.save", "save pairing"], ["tui.select.cancel", "cancel"] ] as const)
			.flatMap(([action, label]) => { const keys = this.keys.getKeys(action); return keys.length ? [`${keys.join("/")}: ${label}`] : []; }).join(" · ");
		const selected = this.list.getSelectedItem();
		return [this.theme.fg("border", "─".repeat(Math.max(0, width))),
			...new Text(this.theme.fg("accent", `Advisor for ${visible(this.options.main)}`), 0, 0).render(width),
			"", ...this.input.render(width), "", ...this.list.render(width), "",
			...(selected ? new Text(this.theme.fg("muted", `Selected: ${visible(selected.value)}`), 0, 0).render(width) : []), "",
			...new Text(this.theme.fg("dim", hint), 0, 0).render(width),
			this.theme.fg("border", "─".repeat(Math.max(0, width)))].map((line) => truncateToWidth(line, width));
	}
	invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
