import { getMarkdownTheme, type AgentToolResult, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container, Input, Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi,
	type Component, type Focusable, type Keybinding, type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { PlanSnapshot } from "./store.ts";

export interface Answer {
	question: string;
	answer: string;
}

export interface QuestionPrompt {
	question: string;
	options?: string[];
}

export interface QuestionOutcome {
	cancelled: boolean;
	answers: Answer[];
}

export interface ToolDetails {
	status: string;
	message: string;
	planPath?: string;
	snapshot?: PlanSnapshot;
	answers?: Answer[];
	token?: string;
}

export const APPROVAL_CHOICES = ["Execute from checkpoint", "Continue here", "Request changes", "Keep planning"];

const OTHER_ANSWER = "Type an answer…";

export function toolResult(details: ToolDetails, options: { terminate?: boolean; isError?: boolean } = {}, text = details.message): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		...options,
	};
}

export function renderTextResult(result: AgentToolResult<ToolDetails>): Text {
	return new Text(result.details?.message ?? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0);
}

/** A normal Markdown transcript row, including while the approval selector owns the editor. */
export function renderPlanResult(result: AgentToolResult<ToolDetails>): Container {
	const view = new Container();
	if (result.details?.snapshot) {
		view.addChild(new Markdown(result.details.snapshot.markdown, 0, 1, getMarkdownTheme()));
	}
	view.addChild(renderTextResult(result));
	return view;
}

export interface QuestionDialogOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender: () => void;
	done: (outcome: QuestionOutcome) => void;
	signal?: AbortSignal;
}

interface Choice {
	marker: string;
	text: string;
	answer: string;
	other: boolean;
}

/**
 * One dialog for a whole question batch. The question sits in a barred block, choices
 * hang under their numbers, and the free-text choice swaps the list for an inline input.
 */
export class QuestionDialog implements Component, Focusable {
	private readonly questions: { question: string; options: string[] }[];
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly input: Input;
	private readonly signal?: AbortSignal;
	private readonly requestRender: () => void;
	private readonly complete: (outcome: QuestionOutcome) => void;
	private readonly abort: () => void;
	private readonly answers: Answer[] = [];
	private current = 0;
	private selected = 0;
	private editing: boolean;
	private closed = false;
	private cache?: { width: number; lines: string[] };

	constructor(questions: QuestionPrompt[], options: QuestionDialogOptions) {
		this.questions = questions.map((prompt) => ({ question: prompt.question, options: prompt.options ?? [] }));
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.signal = options.signal;
		this.requestRender = options.requestRender;
		this.editing = this.questions[0].options.length === 0;
		this.input = new Input({ prompt: "", placeholder: "Type your answer", placeholderStyle: (text) => this.theme.fg("dim", text) });
		this.abort = () => this.complete({ cancelled: true, answers: [...this.answers] });
		this.complete = (outcome) => {
			if (this.closed) return;
			this.closed = true;
			this.signal?.removeEventListener("abort", this.abort);
			options.done(outcome);
		};
		this.input.onSubmit = (value) => { if (value.trim()) this.record(value.trim()); };
		this.input.onEscape = () => {
			if (!this.currentQuestion().options.length) { this.complete({ cancelled: true, answers: [...this.answers] }); return; }
			this.editing = false;
			this.input.setValue("");
			this.refresh();
		};
		options.signal?.addEventListener("abort", this.abort, { once: true });
	}

	/** Focus belongs to the inline input so the terminal cursor and IME follow it. */
	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		if (value === this.input.focused) return;
		this.input.focused = value;
		this.refresh();
	}

	/** Release the abort subscription when the host drops the dialog without an answer. */
	dispose(): void {
		this.closed = true;
		this.signal?.removeEventListener("abort", this.abort);
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.editing) {
			this.input.handleInput(data);
			this.refresh();
			return;
		}
		const choices = this.choices();
		if (this.keybindings.matches(data, "tui.select.up")) { this.selected = (this.selected + choices.length - 1) % choices.length; this.refresh(); return; }
		if (this.keybindings.matches(data, "tui.select.down")) { this.selected = (this.selected + 1) % choices.length; this.refresh(); return; }
		if (this.keybindings.matches(data, "tui.select.cancel")) { this.complete({ cancelled: true, answers: [...this.answers] }); return; }
		if (!this.keybindings.matches(data, "tui.select.confirm")) return;
		const choice = choices[this.selected];
		if (choice.other) {
			this.editing = true;
			this.input.setValue("");
			this.refresh();
			return;
		}
		this.record(choice.answer);
	}

	render(width: number): string[] {
		const size = Math.max(1, width);
		if (this.cache?.width === size) return this.cache.lines;
		const theme = this.theme;
		const question = this.currentQuestion();
		const lines: string[] = [];

		lines.push(theme.fg("accent", "─".repeat(size)));
		const title = this.questions.length > 1 ? `Ask question · ${this.current + 1} of ${this.questions.length}` : "Ask question";
		lines.push(truncateToWidth(" " + theme.fg("accent", theme.bold(title)), size, ""));
		lines.push("");
		this.renderQuestion(lines, question.question, size);
		lines.push("");
		if (question.options.length) {
			this.renderChoices(lines, size);
			lines.push("");
		}
		if (this.editing) {
			for (const line of this.input.render(Math.max(1, size - 4))) lines.push(`  ${theme.fg("accent", "❯")} ${line}`);
			lines.push("");
		}
		lines.push(truncateToWidth(" " + this.hints(question.options.length > 0, size), size, ""));
		lines.push(theme.fg("accent", "─".repeat(size)));
		this.cache = { width: size, lines };
		return lines;
	}

	private currentQuestion(): { question: string; options: string[] } {
		return this.questions[this.current];
	}

	private choices(): Choice[] {
		return [
			...this.currentQuestion().options.map((text, index) => ({ marker: `${index + 1}. `, text, answer: text, other: false })),
			{ marker: "✎ ", text: OTHER_ANSWER, answer: "", other: true },
		];
	}

	private record(answer: string): void {
		this.answers[this.current] = { question: this.currentQuestion().question, answer };
		if (this.current + 1 < this.questions.length) {
			this.current += 1;
			this.selected = 0;
			this.input.setValue("");
			this.editing = this.currentQuestion().options.length === 0;
			this.refresh();
			return;
		}
		this.complete({ cancelled: false, answers: [...this.answers] });
	}

	private refresh(): void {
		this.cache = undefined;
		this.requestRender();
	}

	/** The question as a barred block so it reads as context rather than another choice. */
	private renderQuestion(lines: string[], question: string, width: number): void {
		const bar = this.theme.fg("border", "│");
		for (const segment of question.split("\n")) {
			const wrapped = wrapTextWithAnsi(segment, Math.max(1, width - 3));
			if (!wrapped.length) { lines.push(` ${bar}`); continue; }
			for (const line of wrapped) lines.push(` ${bar} ${this.theme.fg("text", line)}`);
		}
	}

	private renderChoices(lines: string[], width: number): void {
		const theme = this.theme;
		const choices = this.choices();
		for (let index = 0; index < choices.length; index += 1) {
			const choice = choices[index];
			const active = index === this.selected;
			const markerWidth = visibleWidth(choice.marker);
			const body = wrapTextWithAnsi(choice.text, Math.max(1, width - 3 - markerWidth));
			const head = active ? `${theme.fg("accent", "→")} ` : "  ";
			const indent = " ".repeat(3 + markerWidth);
			// The selected row is padded to the full width so the highlight reads as a bar.
			for (let line = 0; line < body.length; line += 1) {
				const text = theme.fg(active || !choice.other ? "text" : "muted", body[line]);
				const row = line === 0
					? ` ${head}${theme.fg(active ? "accent" : "dim", choice.marker)}${text}`
					: `${indent}${text}`;
				lines.push(active ? theme.style(row + " ".repeat(Math.max(0, width - visibleWidth(row))), { bg: "selectedBg" }) : row);
			}
		}
	}

	/** Key hints mirror Pi's own dialogs; narrow terminals drop the descriptions before the keys. */
	private hints(withOptions: boolean, width: number): string {
		const theme = this.theme;
		const keys = (keybinding: Keybinding) => this.keybindings.getKeys(keybinding).join("/");
		const hint = (key: string, description?: string) => theme.fg("dim", key) + (description ? theme.fg("muted", ` ${description}`) : "");
		const submit = keys("tui.input.submit");
		const confirm = keys("tui.select.confirm");
		const cancel = keys("tui.select.cancel");
		const described = this.editing
			? [hint(submit, "submit"), hint(cancel, withOptions ? "back" : "cancel")]
			: [hint("↑↓", "navigate"), hint(confirm, "select"), hint(cancel, "cancel")];
		const terse = this.editing ? [hint(submit), hint(cancel)] : [hint("↑↓"), hint(confirm), hint(cancel)];
		const full = described.join("  ");
		return visibleWidth(full) + 1 <= width ? full : terse.join("  ");
	}
}

export async function askQuestions(
	ctx: ExtensionContext,
	questions: QuestionPrompt[],
	signal: AbortSignal,
): Promise<QuestionOutcome> {
	if (signal.aborted) return { cancelled: true, answers: [] };
	if (!questions.length) return { cancelled: false, answers: [] };
	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		return ctx.ui.custom<QuestionOutcome>((tui, theme, keybindings, done) => new QuestionDialog(questions, {
			theme, keybindings, signal, done, requestRender: () => tui.requestRender(),
		}));
	}
	const answers: Answer[] = [];
	for (const question of questions) {
		if (signal.aborted) return { cancelled: true, answers };
		let answer: string | undefined;
		const options = question.options ?? [];
		if (options.length) {
			const numbered = options.map((option, index) => `${index + 1}. ${option}`);
			const choice = await ctx.ui.select(question.question, [...numbered, OTHER_ANSWER], { signal });
			if (choice === undefined || signal.aborted) return { cancelled: true, answers };
			answer = choice === OTHER_ANSWER ? await ctx.ui.input(question.question, "Your answer", { signal }) : options[numbered.indexOf(choice)];
		} else {
			answer = await ctx.ui.input(question.question, "Your answer", { signal });
		}
		if (answer === undefined || !answer.trim() || signal.aborted) return { cancelled: true, answers };
		answers.push({ question: question.question, answer });
	}
	return { cancelled: false, answers };
}
