import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./host.mjs";

export const f = fixture();
export const sdk = await import(`${f.host}/dist/index.js`);
export const ai = await import(`${f.host}/../pi-ai/dist/index.js`);
export const { default: register } = await f.load("index.ts");
export const store = await f.load("store.ts");
export const ui = await f.load("ui.ts");
export const PLAN = "# Fixture plan\n\n## Goal\nImplement the requested change.\n\n## Steps\n1. Update `src/example.ts`.\n2. Run the focused tests.\n\n## Verification\nThe regression test passes.\n";
export const text = (text) => ({ type: "text", text });
export const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Real Pi loop and session tree; all model replies and user dialogs are offline fixtures. */
export async function setup({ choice = "Execute from checkpoint", next, before = [], extras = [], flags = {}, flag = false, hasUI = true, planText = PLAN, persistent = false, builtin = false } = {}) {
	const root = mkdtempSync(join(f.scratch, "session-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const model = { type: "chat", id: "fixture", name: "Fixture", provider: "plan-fixture", api: "openai-completions", baseUrl: "https://invalid.test", input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let session, api;
	const requests = [], notices = [], selections = [], inputs = [], errors = [], navigations = [], updates = [];
	const controls = { choice, input: "Revise the verification step.", onSelect: undefined, onInput: undefined, navigation: undefined };
	const stream = (selected, context) => {
		requests.push(structuredClone(context));
		const turn = requests.length;
		assert.ok(turn <= 12, "Unexpected model continuation loop");
		let path;
		try { path = store.restorePlan(session.sessionManager.getBranch())?.path; }
		catch { /* Fault-injection cases still need the model to attempt a guarded tool call. */ }
		const content = next ? next({ turn, context, session, path, controls, api })
			: turn === 1 ? [call("enter", "enter_plan_mode")]
				: turn === 2 ? [call("draft", "draft_fixture")]
					: turn === 3 ? [call("exit", "exit_plan_mode", { plan_path: path })]
						: [text("IMPLEMENTATION_STARTED")];
		const message = { role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id, stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", usage, timestamp: Date.now() };
		const result = ai.createAssistantMessageEventStream();
		result.push({ type: "start", partial: message });
		result.push({ type: "done", reason: message.stopReason, message });
		result.end();
		return result;
	};
	const credentials = new ai.InMemoryCredentialStore();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline-fixture" }));
	const runtime = await sdk.ModelRuntime.create({ credentials, modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(ai.createProvider({ id: model.provider, name: "Offline fixture", models: [model], auth: { apiKey: ai.envApiKeyAuth("Fixture", []) }, api: { "openai-completions": { stream, streamSimple: stream } } }));
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [...before, register, (pi) => { api = pi; }, ...extras],
		systemPromptOverride: () => "Offline planning fixture.",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	loader.getExtensions().runtime.flagValues.set("plan", flag);
	for (const [name, value] of Object.entries(flags)) loader.getExtensions().runtime.flagValues.set(name, value);
	({ session } = await sdk.createAgentSession({
		cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager,
		sessionManager: persistent ? sdk.SessionManager.create(cwd, join(root, "sessions")) : sdk.SessionManager.inMemory(cwd), ...(builtin ? {} : { noTools: "builtin" }),
		customTools: [{
			name: "draft_fixture", label: "Draft", description: "Write the test-owned plan fixture.", parameters: ai.Type.Object({}),
			execute: async () => {
				const plan = store.restorePlan(session.sessionManager.getBranch());
				assert.ok(plan?.path.startsWith(process.env.XDG_CACHE_HOME + "/"));
				writeFileSync(plan.path, planText);
				return { content: [text("INVESTIGATION_DEBRIS")], details: undefined };
			},
		}],
	}));
	const uiContext = {
		theme: { fg: (_color, value) => value },
		setStatus() {},
		notify: (message, type) => notices.push({ message, type }),
		select: async (title, options, opts) => {
			selections.push({ title, options });
			await controls.onSelect?.({ title, options, signal: opts?.signal, session, api });
			return opts?.signal?.aborted ? undefined : controls.choice;
		},
		input: async (title, placeholder, opts) => {
			inputs.push({ title, placeholder });
			await controls.onInput?.({ title, signal: opts?.signal, session, api });
			return opts?.signal?.aborted ? undefined : controls.input;
		},
		getEditorText: () => "",
	};
	await session.bindExtensions({
		mode: hasUI ? "rpc" : "print", ...(hasUI ? { uiContext } : {}), onError: (error) => errors.push(error.error),
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			navigateTree: async (id, options) => {
				navigations.push({ id, options, streaming: session.isStreaming });
				if (controls.navigation) return controls.navigation(id, options);
				return session.navigateTree(id, options);
			},
		},
	});
	session.subscribe((event) => { if (event.type === "tool_execution_update") updates.push(event); });
	return {
		session, api, controls, requests, notices, selections, inputs, errors, navigations, updates, cwd, agentDir,
		plan: () => store.restorePlan(session.sessionManager.getBranch()),
		async run(prompt = "Plan the requested change.") {
			// Slash commands can launch a prompt asynchronously before isStreaming becomes true.
			let finishPlanning, finishExecution;
			let settlements = 0, executionQueued = false;
			const settled = new Promise((resolve) => { finishPlanning = resolve; });
			const executed = new Promise((resolve) => { finishExecution = resolve; });
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "custom" && event.message.customType === "plan-mode-execute") executionQueued = true;
				if (event.type === "agent_settled") { if (++settlements === 1) finishPlanning(); else finishExecution(); }
			});
			try {
				await session.prompt(prompt); await settled;
				if (executionQueued) await executed;
				await session.waitForIdle(); assert.deepEqual(errors, []);
			} finally { unsubscribe(); }
		},
		close: () => session.dispose(),
	};
}
