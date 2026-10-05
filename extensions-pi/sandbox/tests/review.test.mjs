import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ARM_DELAY_MS, previewLines, ReviewModal } from "../modal.ts";
import { createReviewer, defaultReviewerName, denialReason } from "../review.ts";

const plain = { fg: (_color, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
const request = {
	toolName: "bash",
	input: { command: "uv sync\nuv run x.py" },
	cwd: "/work",
	subject: "bash",
	excess: ["writableLocations /home/u/.cache/uv", 'networkAccess "full"'],
	always: "writableLocations /home/u/.cache/uv",
};

function modal(req = request) {
	let clock = 0;
	const verdicts = [];
	const m = new ReviewModal(tui, plain, req, (v) => verdicts.push(v), () => clock);
	return { m, verdicts, advance: (ms) => (clock += ms) };
}

test("keys are ignored until the modal is armed, then map to verdicts", (t) => {
	const { m, verdicts, advance } = modal();
	t.after(() => m.dispose());
	m.handleInput("\r");
	advance(ARM_DELAY_MS - 1);
	m.handleInput("y");
	assert.deepEqual(verdicts, [], "early keys do not answer");
	advance(1);
	m.handleInput("\r");
	m.handleInput("n");
	assert.deepEqual(verdicts, [{ kind: "approve" }], "first answer wins");

	for (const [key, verdict] of [
		["y", { kind: "approve" }],
		["a", { kind: "always" }],
		["n", { kind: "deny" }],
		["\x1b", { kind: "deny" }],
		["f", "feedback"],
	]) {
		const { m: other, verdicts: got, advance: wait } = modal();
		wait(ARM_DELAY_MS);
		other.handleInput("x");
		other.handleInput(key);
		other.dispose();
		assert.deepEqual(got, [verdict], key);
	}
	const { m: noAlways, verdicts: none, advance: wait } = modal({ ...request, always: undefined });
	wait(ARM_DELAY_MS);
	noAlways.handleInput("a");
	noAlways.dispose();
	assert.deepEqual(none, [], "no always option when it cannot be pre-approved");
});

test("render shows the command, the excess grants, and the keys, within the width", (t) => {
	const { m } = modal();
	t.after(() => m.dispose());
	const lines = m.render(60);
	const text = lines.join("\n");
	assert.match(text, /Permission request · bash/);
	assert.match(text, /\$ uv sync\n {3}uv run x\.py/);
	assert.match(text, /⚠ writableLocations \/home\/u\/\.cache\/uv/);
	assert.match(text, /⚠ networkAccess "full"/);
	assert.match(text.replace(/\s+/g, " "), /enter\/y yes · a always · esc\/n no · f no, with feedback/);
	assert.doesNotMatch(text, /\.\.\./, "nothing is truncated");
	assert.match(text, /always adds to this session: writableLocations/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 60, line);
});

test("previews: edit diff, write content, other tools as JSON", () => {
	const edit = previewLines(
		{ ...request, toolName: "edit", input: { path: "a.ts", edits: [{ oldText: "x = 1", newText: "x = 2" }] } },
		plain,
	);
	assert.deepEqual(edit, ["edit a.ts", "- x = 1", "+ x = 2"]);
	const write = previewLines({ ...request, toolName: "write", input: { path: "/nonexistent/n.txt", content: "a\nb" } }, plain);
	assert.deepEqual(write, ["create /nonexistent/n.txt", "+ a", "+ b"]);
	const long = previewLines({ ...request, input: { command: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") } }, plain);
	assert.equal(long.length, 25);
	assert.equal(long.at(-1), "… 16 more lines");
	assert.deepEqual(previewLines({ ...request, toolName: "mcp_x", input: { q: 1 } }, plain), ["{", '  "q": 1', "}"]);
});

test("reviewer selection and denial reasons", async () => {
	assert.equal(defaultReviewerName("tui"), "manual");
	assert.equal(defaultReviewerName("print"), "deny");
	assert.equal(createReviewer("deny", "print").name, "deny");
	assert.equal(createReviewer("manual", "tui").name, "manual");
	assert.throws(() => createReviewer("manual", "print"), /manual needs the interactive TUI/);
	assert.throws(() => createReviewer("auto", "tui"), /not available yet/);
	assert.throws(() => createReviewer("nope", "tui"), /must be one of deny, manual, auto, auto-manual/);
	assert.deepEqual(await createReviewer("deny", "print").review(request, {}), { kind: "deny" });
	assert.match(
		denialReason(request, { kind: "deny" }, "deny", "read-only"),
		/^Blocked: bash needs writableLocations \/home\/u\/\.cache\/uv; networkAccess "full", beyond this run's permissions \(read-only\)\./,
	);
	assert.match(
		denialReason(request, { kind: "deny", feedback: "use the project venv" }, "manual", "read-only"),
		/^The user denied this call: bash needs .*\. Feedback: use the project venv Do not retry/,
	);
});
