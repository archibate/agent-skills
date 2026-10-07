import assert from "node:assert/strict";
import { test } from "node:test";
import register, { buildFreshPrompt } from "../index.ts";

const user = (content) => ({ type: "message", message: { role: "user", content } });

function harness(entries, {
	draft = "", hasUI = true, mode = "tui", approve = true, choice = 0,
	idle = true, pending = false, cancelled = false, failure,
} = {}) {
	let command;
	let editor = draft;
	const history = entries.map((entry, index) => ({
		...entry, id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
	}));
	const state = { leaf: history.at(-1)?.id ?? null, session: "same-session", idle, pending };
	const notifications = [];
	const confirmations = [];
	const selections = [];
	const navigations = [];
	const markers = [];
	register({
		registerCommand: (name, value) => { assert.equal(name, "fresh"); command = value; },
		appendEntry: (customType, data) => {
			markers.push({ customType, data });
			history.push({ type: "custom", id: "marker", parentId: state.leaf, customType, data });
			state.leaf = "marker";
		},
	});
	const ctx = {
		hasUI, mode,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		sessionManager: {
			getSessionId: () => state.session,
			getLeafId: () => state.leaf,
			getBranch: () => {
				const branch = [];
				let entry = history.find((entry) => entry.id === state.leaf);
				while (entry) {
					branch.unshift(entry);
					entry = history.find((candidate) => candidate.id === entry.parentId);
				}
				return branch;
			},
			getEntries: () => { throw new Error("Must not include abandoned branches"); },
			buildSessionContext: () => { throw new Error("Must not use assistant compaction summaries"); },
		},
		navigateTree: async (id, options) => {
			navigations.push({ id, options });
			if (failure) throw failure;
			if (cancelled) return { cancelled: true };
			// Match Pi's same-leaf no-op and user-target parent semantics.
			if (id === state.leaf) return { cancelled: false };
			const entry = history.find((entry) => entry.id === id);
			state.leaf = entry.parentId;
			const content = entry.message.content;
			const text = typeof content === "string" ? content
				: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
			if (text && !editor.trim()) editor = text;
			return { cancelled: false };
		},
		ui: {
			getEditorText: () => editor,
			setEditorText: (text) => { editor = text; },
			select: async (title, options) => { selections.push({ title, options }); return options[choice]; },
			confirm: async (...args) => { confirmations.push(args); return approve; },
			notify: (...args) => notifications.push(args),
		},
	};
	return { ctx, command, state, history, notifications, confirmations, selections, navigations, markers, editor: () => editor };
}

test("preserves every non-empty user message verbatim and in order, including repeated requests", () => {
	const text = "  Design it.\n\n```ts\nconst x = 1;\n```\n中文 🙂  ";
	const entries = [user(text), user("Actually, use Y."), user(text)];
	const before = structuredClone(entries);
	const result = buildFreshPrompt(entries);
	assert.equal(result.messageCount, 3);
	assert.equal(result.omittedImages, 0);
	assert.ok(result.prompt.endsWith(`## User message 1\n\n${text}\n\n## User message 2\n\nActually, use Y.\n\n## User message 3\n\n${text}`));
	assert.deepEqual(entries, before);
});

test("omits assistant replies, thinking, tools, system messages, summaries, and extension data", () => {
	const result = buildFreshPrompt([
		user("Before compaction"),
		...['assistant', 'toolResult', 'system', 'custom', 'bashExecution'].map((role) => ({
			type: "message", message: { role, content: "DO NOT EXPORT" },
		})),
		...['compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit'].map((type) => ({
			type, summary: "DO NOT EXPORT", content: "DO NOT EXPORT", replacement: { content: "DO NOT EXPORT" },
		})),
		user("After compaction"),
	]);
	assert.equal(result.messageCount, 2);
	assert.doesNotMatch(result.prompt, /DO NOT EXPORT/);
	assert.match(result.prompt, /Before compaction[\s\S]*After compaction/);
});

test("extracts text blocks in order and counts omitted images without leaking base64", () => {
	const result = buildFreshPrompt([
		user([{ type: "text", text: "First" }, { type: "image", data: "SECRET", mimeType: "image/png" }, { type: "text", text: "Second" }]),
		user([{ type: "image", data: "SECRET", mimeType: "image/png" }]),
	]);
	assert.equal(result.messageCount, 1);
	assert.equal(result.omittedImages, 2);
	assert.ok(result.prompt.endsWith("First\nSecond"));
	assert.doesNotMatch(result.prompt, /SECRET/);
});

test("empty and whitespace-only messages produce no prompt", () => {
	assert.deepEqual(buildFreshPrompt([user(""), user(" \n\t"), user([])]), {
		prompt: "", messageCount: 0, omittedImages: 0,
	});
});

test("does not truncate large user messages", () => {
	const text = "x".repeat(100_000);
	assert.ok(buildFreshPrompt([user(text)]).prompt.endsWith(text));
});

const assistant = { type: "message", message: { role: "assistant", content: "Old approach" } };

test("defaults to the first user, rewinds in place, and fills one prompt without sending", async () => {
	const entries = [user("Initial question"), assistant, user("Correction"), assistant];
	const h = harness(entries);
	const before = structuredClone(h.history);
	await h.command.handler("", h.ctx);
	assert.equal(h.editor(), buildFreshPrompt(entries).prompt);
	assert.equal(h.state.leaf, null);
	assert.equal(h.state.session, "same-session");
	assert.deepEqual(h.ctx.sessionManager.getBranch(), []);
	assert.deepEqual(h.history, before); // Abandoned branch remains available.
	assert.deepEqual(h.navigations, [{ id: "entry-0", options: { summarize: false } }]);
	assert.deepEqual(h.selections[0].options, ["1. Initial question", "2. Correction"]);
	assert.equal(h.confirmations.length, 0);
	assert.equal(h.markers.length, 0);
	assert.match(h.notifications[0][0], /ready to edit and send/);
});

test("a later starting point keeps earlier context and extracts only the selected suffix", async () => {
	const entries = [user("Keep earlier context"), assistant, user("Restart here"), assistant, user("Latest correction"), assistant];
	const h = harness(entries, { choice: 1 });
	await h.command.handler("", h.ctx);
	assert.equal(h.state.leaf, "entry-1");
	assert.equal(h.ctx.sessionManager.getBranch().length, 2);
	assert.equal(h.editor(), buildFreshPrompt(entries.slice(2)).prompt);
	assert.doesNotMatch(h.editor(), /Keep earlier context|Old approach/);
	assert.equal(h.navigations[0].id, "entry-2");
});

test("handles a selected user that is already the leaf, including a root user", async () => {
	for (const entries of [[user("Only user")], [user("Earlier"), assistant, user("Latest")]]) {
		const h = harness(entries, { choice: entries.length === 1 ? 0 : 1 });
		await h.command.handler("", h.ctx);
		assert.equal(h.state.leaf, entries.length === 1 ? null : "entry-1");
		assert.deepEqual(h.markers, [{ customType: "fresh-navigation", data: {} }]);
		assert.equal(h.editor(), buildFreshPrompt(entries.slice(-1)).prompt);
	}
});

test("canceling the picker leaves both the branch and draft untouched", async () => {
	const h = harness([user("Question"), assistant], { draft: "Keep me", choice: -1 });
	await h.command.handler("", h.ctx);
	assert.equal(h.editor(), "Keep me");
	assert.equal(h.state.leaf, "entry-1");
	assert.equal(h.navigations.length, 0);
	assert.equal(h.confirmations.length, 0);
});

test("picker distinguishes repeated prompts and normalizes previews without changing text", async () => {
	const text = "Same\n  question 中文";
	const h = harness([user(text), assistant, user(text), assistant], { choice: 1 });
	await h.command.handler("", h.ctx);
	assert.deepEqual(h.selections[0].options, ["1. Same question 中文", "2. Same question 中文"]);
	assert.equal(h.navigations[0].id, "entry-2");
	assert.equal(h.editor(), buildFreshPrompt([user(text)]).prompt);
});

test("navigation cancellation and failure do not populate the editor", async () => {
	for (const options of [{ cancelled: true }, { failure: new Error("Navigation rejected") }]) {
		const h = harness([user("Question"), assistant], { draft: "Keep me", ...options });
		await h.command.handler("", h.ctx);
		assert.equal(h.editor(), "Keep me");
		assert.equal(h.state.leaf, "entry-1");
		if (options.failure) assert.match(h.notifications[0][0], /Navigation rejected/);
	}
});

test("cancellation at a user leaf retains only a context-free marker, not a new prompt", async () => {
	for (const options of [{ cancelled: true }, { failure: new Error("Rejected") }]) {
		const h = harness([user("Question")], { draft: "Keep me", ...options });
		await h.command.handler("", h.ctx);
		assert.equal(h.editor(), "Keep me");
		assert.equal(h.state.leaf, "marker");
		assert.deepEqual(h.ctx.sessionManager.getBranch().map((entry) => entry.type), ["message", "custom"]);
		assert.equal(buildFreshPrompt(h.ctx.sessionManager.getBranch()).messageCount, 1);
	}
});

test("typing while asynchronous navigation is pending preserves the new draft", async () => {
	for (const draft of ["", "  ", "Approved old draft"]) {
		const h = harness([user("Question"), assistant], { draft });
		let entered, release;
		const waiting = new Promise((resolve) => { entered = resolve; });
		const gate = new Promise((resolve) => { release = resolve; });
		const navigate = h.ctx.navigateTree;
		h.ctx.navigateTree = async (...args) => { entered(); await gate; return navigate(...args); };
		const running = h.command.handler("", h.ctx);
		await waiting;
		h.ctx.ui.setEditorText("Typed during navigation");
		release();
		await running;
		assert.equal(h.editor(), "Typed during navigation");
		assert.equal(h.state.leaf, null);
		assert.match(h.notifications[0][0], /changed during navigation; draft kept/);
	}
});

test("replaces Pi's automatic restoration of text blocks with one combined prompt", async () => {
	const entries = [user([{ type: "text", text: "First" }, { type: "text", text: "Second" }]), assistant];
	const h = harness(entries, { draft: "  " });
	await h.command.handler("", h.ctx);
	assert.equal(h.editor(), buildFreshPrompt(entries).prompt);
});

test("session changes during navigation do not receive the prepared draft", async () => {
	for (const change of [
		(h) => { h.state.session = "other-session"; },
		(h) => { h.state.idle = false; },
		(h) => { h.state.pending = true; },
	]) {
		const h = harness([user("Question"), assistant], { draft: "Keep me" });
		const navigate = h.ctx.navigateTree;
		h.ctx.navigateTree = async (...args) => { const result = await navigate(...args); change(h); return result; };
		await h.command.handler("", h.ctx);
		assert.equal(h.editor(), "Keep me");
		assert.match(h.notifications[0][0], /changed during navigation/);
	}
});

test("busy or queued sessions are rejected before opening the picker", async () => {
	for (const options of [{ idle: false }, { pending: true }]) {
		const h = harness([user("Question"), assistant], options);
		await h.command.handler("", h.ctx);
		assert.equal(h.selections.length, 0);
		assert.equal(h.navigations.length, 0);
		assert.match(h.notifications[0][0], /Wait for the agent/);
	}
});

test("session and editor changes during either dialog prevent stale navigation", async () => {
	for (const dialog of ["select", "confirm"]) {
		for (const change of [
			(h) => { h.state.leaf = "entry-0"; },
			(h) => { h.state.session = "other-session"; },
			(h) => { h.state.idle = false; },
			(h) => { h.state.pending = true; },
			(h) => { h.ctx.ui.setEditorText("Changed draft"); },
		]) {
			const h = harness([user("Question"), assistant], { draft: "Keep me" });
			const original = h.ctx.ui[dialog];
			h.ctx.ui[dialog] = async (...args) => { change(h); return original(...args); };
			await h.command.handler("", h.ctx);
			assert.equal(h.navigations.length, 0);
			assert.equal(h.markers.length, 0);
			assert.match(h.notifications[0][0], /changed; run \/fresh again/);
		}
	}
});

test("canceling replacement keeps the existing draft", async () => {
	const h = harness([user("Question")], { draft: "Unsent draft", approve: false });
	await h.command.handler("", h.ctx);
	assert.equal(h.confirmations.length, 1);
	assert.equal(h.editor(), "Unsent draft");
});

test("confirmed replacement populates the prompt", async () => {
	const h = harness([user("Question")], { draft: "Unsent draft" });
	await h.command.handler("", h.ctx);
	assert.equal(h.confirmations.length, 1);
	assert.equal(h.editor(), buildFreshPrompt([user("Question")]).prompt);
});

test("a draft changed during confirmation is not overwritten", async () => {
	const h = harness([user("Question")], { draft: "Old draft" });
	h.ctx.ui.confirm = async () => { h.ctx.ui.setEditorText("New draft"); return true; };
	await h.command.handler("", h.ctx);
	assert.equal(h.editor(), "New draft");
	assert.match(h.notifications[0][0], /Editor changed/);
});

test("empty branch keeps the editor and reports why", async () => {
	const h = harness([], { draft: "Keep me" });
	await h.command.handler("", h.ctx);
	assert.equal(h.editor(), "Keep me");
	assert.equal(h.confirmations.length, 0);
	assert.match(h.notifications[0][0], /No user text/);
});

test("warns about images for mixed and image-only messages", async () => {
	for (const entries of [[user("Question"), user([{ type: "image", data: "secret" }])], [user([{ type: "image", data: "secret" }])]]) {
		const h = harness(entries);
		await h.command.handler("", h.ctx);
		assert.equal(h.notifications[0][1], "warning");
		assert.match(h.notifications[0][0], /image|Image/);
		assert.doesNotMatch(h.editor(), /secret/);
	}
});

test("rejects arguments and non-terminal contexts without changing the editor", async () => {
	for (const options of [{ args: "extra" }, { hasUI: false }, { mode: "rpc", hasUI: true }, { mode: "json" }]) {
		const h = harness([user("Question")], { draft: "Keep me", ...options });
		await h.command.handler(options.args ?? "", h.ctx);
		assert.equal(h.editor(), "Keep me");
		assert.equal(h.confirmations.length, 0);
		assert.equal(h.notifications[0][1], "warning");
	}
});
