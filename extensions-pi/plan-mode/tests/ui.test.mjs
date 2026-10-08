import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fixture } from "./host.mjs";

const f = fixture();
after(f.cleanup);
const sdk = await import(`${f.host}/dist/index.js`);
const tui = await import(`${f.host}/../pi-tui/dist/index.js`);
const { renderPlanResult, renderTextResult, askQuestions, toolResult } = await f.load("ui.ts");

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
				const plain = lines.map(tui.stripTerminalSequences).join("\n");
				assert.match(plain, /Plan · 计划/);
				assert.match(plain, /const enabled = true/);
				assert.match(plain, /中文回答/);
				assert.ok(plain.includes(message));
				assert.equal(plain.split("Plan · 计划").length - 1, 1);
				captures.push(`=== ${theme} · ${width} columns · ${message} ===\n${plain}`);
			}
		}
	}
	if (process.env.PI_PLAN_RENDER_OUTPUT) writeFileSync(process.env.PI_PLAN_RENDER_OUTPUT, captures.join("\n\n"));
});

test("tool errors without structured details remain visible", () => {
	const result = { content: [{ type: "text", text: "Cannot read plan file" }], details: undefined, isError: true };
	assert.match(renderTextResult(result).render(40).join("\n"), /Cannot read plan file/);
	assert.match(renderPlanResult(result).render(40).join("\n"), /Cannot read plan file/);
});

test("question options are numbered and retain exact answers; free text is always available", async () => {
	const selections = [];
	const ctx = { ui: {
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
	const ctx = { ui: { input: async () => ++calls === 1 ? "first" : undefined } };
	assert.deepEqual(await askQuestions(ctx, [{ question: "One" }, { question: "Two" }], controller.signal), {
		cancelled: true, answers: [{ question: "One", answer: "first" }],
	});
	controller.abort();
	assert.deepEqual(await askQuestions(ctx, [{ question: "Three" }], controller.signal), { cancelled: true, answers: [] });
	assert.equal(calls, 2);
});
