import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const sdk = await import(`${f.host}/dist/index.js`);
const tui = await import(`${f.host}/../pi-tui/dist/index.js`);
const themeModule = await import(`${f.host}/dist/modes/interactive/theme/theme.js`);
const { renderPlanResult, renderTextResult, askQuestions, toolResult, QuestionDialog } = await f.load("ui.ts");

sdk.initTheme("dark", false);
const theme = themeModule.theme;
const keybindings = new tui.KeybindingsManager(tui.TUI_KEYBINDINGS);
const plain = (lines) => lines.map(tui.stripTerminalSequences).join("\n");

/** Open a dialog with no terminal, capturing renders and the single outcome. */
function open(questions, options = {}) {
	let outcome;
	const dialog = new QuestionDialog(questions, {
		theme, keybindings, signal: options.signal,
		requestRender: () => {},
		done: (result) => { outcome = result; },
	});
	return { dialog, result: () => outcome };
}

const markdown = "# Plan · 计划\n\nKeep the repository unchanged while investigating.\n\n## Implementation\n1. Update `src/feature.ts`.\n2. Add a focused regression test.\n\n```ts\nconst enabled = true;\n```\n\n## Verification\nRun the focused tests. 中文回答 🙂\n";

test("real Pi Markdown renders review and final approval as one complete response at narrow and wide widths", () => {
	const captures = [];
	for (const theme of ["dark", "light"]) {
		sdk.initTheme(theme, false);
		for (const width of [40, 80, 120]) {
			for (const message of ["Awaiting approval", "Approved · continuing here", "Planning remains active."]) {
				const view = renderPlanResult(toolResult({ status: "fixture", message, snapshot: { markdown, path: "/scratch/plan.md", sha256: "fixture" } }));
				const lines = view.render(width);
				assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `${theme} width ${width}`);
				const text = lines.map(tui.stripTerminalSequences).join("\n");
				assert.match(text, /Plan · 计划/);
				assert.match(text, /const enabled = true/);
				assert.match(text, /中文回答/);
				assert.ok(text.includes(message));
				assert.equal(text.split("Plan · 计划").length - 1, 1);
				captures.push(`=== ${theme} · ${width} columns · ${message} ===\n${text}`);
			}
		}
	}
	sdk.initTheme("dark", false);
	if (process.env.PI_PLAN_RENDER_OUTPUT) writeFileSync(process.env.PI_PLAN_RENDER_OUTPUT, captures.join("\n\n"));
});

test("tool errors without structured details remain visible", () => {
	const result = { content: [{ type: "text", text: "Cannot read plan file" }], details: undefined, isError: true };
	assert.match(renderTextResult(result).render(40).join("\n"), /Cannot read plan file/);
	assert.match(renderPlanResult(result).render(40).join("\n"), /Cannot read plan file/);
});

test("question dialog keeps one hierarchy, a barred question, and a full-width selection bar", () => {
	const question = "For “full UI inherited behavior,” I propose: artist/album names appear in the source chip; other song clicks play and stay in the list.";
	const options = ["Yes, use that behavior.", "Only fix the cover destination and animations; keep the current artist/album interactions."];
	const { dialog } = open([{ question, options }]);
	const captures = [];
	for (const width of [40, 80, 120]) {
		dialog.invalidate();
		const lines = dialog.render(width);
		assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `width ${width}`);
		const rows = lines.map(tui.stripTerminalSequences);
		assert.equal(rows[0], "─".repeat(width));
		assert.equal(rows.at(-1), "─".repeat(width));
		assert.equal(rows[1], " Ask question");
		// The question reads as context in a barred block, not as another choice.
		const barred = rows.filter((row) => row.startsWith(" │ "));
		assert.ok(barred.length >= 1);
		const context = barred.join(" ");
		assert.ok(context.includes("artist/album") && context.includes("source chip"), context);
		assert.ok(rows.filter((row) => row.includes("For “full UI")).every((row) => row.startsWith(" │ ")));
		// Choices hang under their numbers; free text is offered last and marked.
		assert.equal(rows.find((row) => row.startsWith(" → 1. ")).trimEnd(), " → 1. Yes, use that behavior.");
		assert.ok(rows.some((row) => row.startsWith("   2. Only fix the cover destination")));
		assert.ok(rows.includes("   ✎ Type an answer…"));
		assert.ok(rows.at(-2).startsWith(" ↑↓"), "the footer is the second-to-last row");
		if (width >= 80) assert.equal(rows.at(-2), " ↑↓ navigate  enter select  escape/ctrl+c cancel");
		else assert.equal(rows.at(-2), " ↑↓  enter  escape/ctrl+c");
		// Exactly one row is selected, and its highlight spans the dialog.
		const highlighted = lines.filter((line) => line.includes("\u001b[48;"));
		assert.equal(highlighted.length, 1);
		assert.equal(tui.visibleWidth(highlighted[0]), width);
		assert.ok(tui.stripTerminalSequences(highlighted[0]).startsWith(" → 1. Yes"));
		captures.push(`=== ${width} columns ===\n${rows.join("\n")}`);
	}
	if (process.env.PI_PLAN_QUESTION_RENDER_OUTPUT) writeFileSync(process.env.PI_PLAN_QUESTION_RENDER_OUTPUT, captures.join("\n\n"));
});

test("wrapped choices align under their text and the question stays within narrow widths", () => {
	const { dialog } = open([{ question: "Explain the trade-offs in detail.", options: ["Short", "A long option that must wrap at a narrow width to stay aligned"] }]);
	const rows = dialog.render(30).map(tui.stripTerminalSequences);
	assert.ok(rows.every((row) => tui.visibleWidth(row) <= 30));
	const start = rows.findIndex((row) => row.startsWith("   2. "));
	assert.ok(start >= 0);
	assert.ok(rows[start].length < 30, "the option wraps instead of overflowing");
	assert.ok(rows[start + 1].startsWith("      "), "the continuation hangs under the option text");
	assert.ok(rows[start + 1].trim().length > 0);
});

test("question dialog answers with the exact option text and advances through the batch", () => {
	const { dialog, result } = open([
		{ question: "Which approach?", options: ["A", "B"] },
		{ question: "Name the flag" },
	]);
	dialog.handleInput("\u001b[B");
	dialog.handleInput("\r");
	assert.equal(result(), undefined, "the batch is not finished after the first answer");
	assert.match(plain(dialog.render(80)), /Ask question · 2 of 2/);
	for (const character of "custom ☂") dialog.handleInput(character);
	dialog.handleInput("\r");
	assert.deepEqual(result(), {
		cancelled: false,
		answers: [{ question: "Which approach?", answer: "B" }, { question: "Name the flag", answer: "custom ☂" }],
	});
});

test("question dialog treats the free-text choice as an inline input, backs out with escape, and cancels with answers kept", () => {
	const { dialog, result } = open([{ question: "Pick", options: ["A"] }, { question: "Explain" }]);
	dialog.handleInput("\u001b[B");
	dialog.handleInput("\r");
	assert.match(plain(dialog.render(60)), /❯/);
	assert.match(plain(dialog.render(60)), /enter submit/);
	dialog.handleInput("\u001b");
	assert.match(plain(dialog.render(60)), /enter select/, "escape returns to the choices");
	dialog.handleInput("\u001b[A");
	dialog.handleInput("\r");
	assert.match(plain(dialog.render(60)), /Explain/);
	dialog.handleInput("\u001b");
	assert.deepEqual(result(), { cancelled: true, answers: [{ question: "Pick", answer: "A" }] });
	dialog.handleInput("\r");
	assert.equal(result().cancelled, true, "a closed dialog ignores later input");
});

test("an abort closes the dialog with only the answers actually submitted", () => {
	const controller = new AbortController();
	const { dialog, result } = open([{ question: "Pick", options: ["A", "B"] }, { question: "Explain" }], { signal: controller.signal });
	dialog.handleInput("\r");
	controller.abort();
	assert.deepEqual(result(), { cancelled: true, answers: [{ question: "Pick", answer: "A" }] });
});

test("focus follows the inline input so the terminal cursor and IME anchor there", () => {
	const { dialog } = open([{ question: "Explain" }]);
	assert.equal(dialog.focused, false);
	assert.equal(dialog.render(40).some((line) => line.includes(tui.CURSOR_MARKER)), false);
	dialog.focused = true;
	assert.equal(dialog.focused, true);
	assert.ok(dialog.render(40).some((line) => line.includes(tui.CURSOR_MARKER)));
});

test("rpc question flow numbers options, keeps exact answers, and always offers free text", async () => {
	const selections = [];
	const ctx = { mode: "rpc", ui: {
		select: async (_title, options) => { selections.push(options); return options[1]; },
		input: async () => " Free text 中文 ",
	} };
	const result = await askQuestions(ctx, [{ question: "Choose", options: ["same", "same"] }, { question: "Explain" }], new AbortController().signal);
	assert.deepEqual(selections, [["1. same", "2. same", "Type an answer…"]]);
	assert.deepEqual(result, { cancelled: false, answers: [{ question: "Choose", answer: "same" }, { question: "Explain", answer: " Free text 中文 " }] });
});

test("cancellation retains only answers actually submitted and abort closes a question batch", async () => {
	let calls = 0;
	const controller = new AbortController();
	const ctx = { mode: "rpc", ui: { input: async () => ++calls === 1 ? "first" : undefined } };
	assert.deepEqual(await askQuestions(ctx, [{ question: "One" }, { question: "Two" }], controller.signal), {
		cancelled: true, answers: [{ question: "One", answer: "first" }],
	});
	controller.abort();
	assert.deepEqual(await askQuestions(ctx, [{ question: "Three" }], controller.signal), { cancelled: true, answers: [] });
	assert.equal(calls, 2);
});
