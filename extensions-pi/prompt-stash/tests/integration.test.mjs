import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Offline loader test: boots the real pi runtime and extension, then drives the
// installed editor with a raw Ctrl+S keypress. Requires PI_SDK_PATH (the
// release's dist/index.js); skipped otherwise.
const sdkPath = process.env.PI_SDK_PATH;

const CTRL_S = "\x13";

function createUi() {
	let editorFactory;
	let editorText = "draft";
	const notices = [];
	const ui = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => notices.push([message, type]),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: (text) => {
			editorText += text;
		},
		setEditorText: (text) => {
			editorText = text;
		},
		getEditorText: () => editorText,
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
		getEditorComponent: () => editorFactory,
		// A CustomEditor only needs a theme with a borderColor to construct.
		theme: { borderColor: (text) => text },
	};
	return {
		ui,
		notices,
		get editorFactory() {
			return editorFactory;
		},
		get editorText() {
			return editorText;
		},
	};
}

test("Ctrl+S in the real editor stashes and restores without a shortcut warning", { skip: !sdkPath }, async (t) => {
	const sdk = await import(pathToFileURL(sdkPath).href);
	const base = mkdtempSync(join(homedir(), ".cache", "pi-prompt-stash-integration-"));
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const errors = [];
	let session;
	t.after(() => {
		session?.dispose?.();
		rmSync(base, { recursive: true, force: true });
	});

	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname],
	});
	await loader.reload();
	session = (
		await sdk.createAgentSession({
			cwd,
			agentDir,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(),
		})
	).session;

	const harness = createUi();
	await session.bindExtensions({
		uiContext: harness.ui,
		mode: "print",
		onError: (error) => errors.push(error.error),
	});
	assert.deepEqual(errors, []);
	// The whole point of the custom editor: no static "shortcut conflict" notice.
	assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), []);

	const editor = harness.editorFactory({}, { borderColor: (text) => text }, {});
	assert.equal(harness.editorText, "draft", "the stub editor holds the draft before the keypress");

	editor.handleInput(CTRL_S);
	assert.equal(harness.editorText, "", "Ctrl+S clears the editor");
	assert.match(harness.notices.at(-1)[0], /stashed/i);

	editor.handleInput(CTRL_S);
	assert.equal(harness.editorText, "draft", "Ctrl+S restores the draft");
	assert.match(harness.notices.at(-1)[0], /restored/i);
	assert.deepEqual(errors, []);
});
