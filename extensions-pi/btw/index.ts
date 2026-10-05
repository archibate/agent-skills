/**
 * /btw - ask a side question without disturbing the main conversation.
 *
 * Cache-preserving fork:
 *   The side session is seeded with the *entire* current branch, including the
 *   system message, and runs with the same cwd, extensions, tools, model, and
 *   session id as the main session. Its provider request is therefore a strict
 *   extension of the main session's last request (system -> tools -> messages ->
 *   question), so the provider's prompt cache serves the whole prefix and only the
 *   question is billed as new input.
 *
 *   Sharing the session id matters twice: extensions may embed it in the system
 *   prompt (the scratchpad extension does), and OpenAI-style `prompt_cache_key`
 *   routing derives from it.
 *
 * Read-only:
 *   The forked session declares the same tools (needed for the cache prefix). `read`,
 *   `grep`, `find`, and `ls` run normally. `bash` is whatever the reloaded extensions
 *   declare, so it matches the main session's. With the sandbox extension (../sandbox)
 *   loaded, bash calls that declare any access beyond its read-only default are blocked
 *   (set `BTW_SANDBOX_NET=1` to also allow networkAccess); without it, bash is blocked.
 *   All other mutating tools are blocked. The SDK does not bind extensions, so the side session calls
 *   bindExtensions() explicitly.
 *
 * Rendering:
 *   The overlay reuses pi's own transcript components - UserMessageComponent,
 *   AssistantMessageComponent, and ToolExecutionComponent - so the side exchange
 *   looks like the main chat, including streaming text, thinking blocks, and tool
 *   call/result rows.
 *
 * Nothing is written back to the main session: the fork lives in an in-memory
 * SessionManager and the command runs immediately even while the main agent is
 * still streaming.
 *
 * Caveats: each invocation loads and starts the session's extensions again (a few
 * hundred ms); the bash sandbox is Linux-only (bubblewrap and Landlock) and fails closed
 * when unavailable; and disposing the shared session id also clears provider
 * session caches keyed by it (currently only OpenAI Codex websockets).
 *
 * Installed as ~/.pi/agent/extensions/btw/ (source: extensions-pi/btw); run /reload.
 */

import {
	type AgentSession,
	type AgentSessionEvent,
	AssistantMessageComponent,
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SandboxProvider, SandboxProviderReply } from "../sandbox/sandbox.ts";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Set BTW_SANDBOX_NET=1 to allow declared network access inside the /btw bash sandbox (default: no network). */
const ALLOW_SANDBOX_NETWORK = process.env.BTW_SANDBOX_NET === "1";

/** pi.events channel of the sandbox extension (see ../sandbox/sandbox.ts PROVIDER_CHANNEL). */
const SANDBOX_CHANNEL = "archibate.sandbox:get";

/** The loaded sandbox extension's provider, if any. It answers synchronously. */
function findSandbox(pi: ExtensionAPI): SandboxProvider | undefined {
	let found: SandboxProvider | undefined;
	const reply: SandboxProviderReply = (provider) => {
		found = provider;
	};
	pi.events.emit(SANDBOX_CHANNEL, reply);
	return found;
}

/**
 * Injected into the forked session's resource loader:
 * - allow `bash` only through the sandbox extension's read-only default; scratchpad stays writable
 * - block the remaining mutating tools, keeping their declarations only for prefix/cache identity
 * - forward the main session's prompt cache key so OpenAI-style routing reuses its cache
 */
function sideTweaks(mainSessionId: string) {
	return (api: ExtensionAPI) => {
		api.on("tool_call", (event) => {
			if (event.toolName === "bash") {
				const sandbox = findSandbox(api);
				if (!sandbox) {
					return { block: true, reason: "bash is disabled in /btw: the sandbox extension is not loaded" };
				}
				const request = (event.input as { sandbox?: Record<string, unknown> }).sandbox;
				const { networkAccess, ...rest } = request ?? {};
				if (sandbox.isReadOnly(ALLOW_SANDBOX_NETWORK ? rest : request)) return undefined;
				return {
					block: true,
					reason: `bash in /btw is read-only: drop the sandbox grants (requested ${JSON.stringify(request)})${networkAccess && !ALLOW_SANDBOX_NETWORK ? "; network needs BTW_SANDBOX_NET=1" : ""}`,
				};
			}
			if (!READ_ONLY_TOOLS.has(event.toolName)) {
				return {
					block: true,
					reason: `${event.toolName} is disabled in /btw (read-only side session)`,
				};
			}
			return undefined;
		});
		api.on("before_provider_request", (event) => {
			const payload = event.payload as Record<string, unknown> | undefined;
			if (payload && typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0) {
				payload.prompt_cache_key = mainSessionId;
			}
			return undefined;
		});
	};
}

/** Fork the whole current branch into a private, read-only session that shares the main prefix. */
async function createSideSession(ctx: ExtensionCommandContext, activeTools: string[]): Promise<AgentSession> {
	const mainSessionId = ctx.sessionManager.getSessionId();
	const branch = ctx.sessionManager.getBranch();
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		extensionFactories: [sideTweaks(mainSessionId)],
	});
	// Reuse the main session's trust decision so project resources match (and no prompt appears).
	await resourceLoader.reload({ resolveProjectTrust: async () => ctx.isProjectTrusted() });

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model: ctx.model,
		...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
		tools: activeTools,
		// Reuse the main session id: extensions and the base prompt may embed it (e.g. the
		// scratchpad path), and the provider cache key derives from it. A fresh id would
		// change the system prompt and break the shared prefix.
		sessionManager: SessionManager.inMemory(ctx.cwd, { id: mainSessionId }, branch),
		resourceLoader,
	});
	// The SDK does not bind extensions, so the injected read-only tool_call guard (and any
	// other tool hooks) would never run. `print` mode keeps extensions off the TUI.
	await session.bindExtensions({ mode: "print" });
	return session;
}

/** Headless path: print the answer on stdout for print / RPC modes. */
async function runHeadless(ctx: ExtensionCommandContext, activeTools: string[], question: string): Promise<void> {
	const session = await createSideSession(ctx, activeTools);
	try {
		await session.prompt(question, { expandPromptTemplates: false });
		process.stdout.write(`${session.getLastAssistantText() ?? "(no answer)"}\n`);
	} finally {
		session.dispose();
	}
}

/**
 * A miniature pi transcript rendered inside an overlay, built from the same components the
 * main chat uses. Mirrors InteractiveMode's event handling for assistant messages and tools.
 */
class BtwView implements Component, Focusable {
	focused = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly close: () => void;
	private readonly modelLabel: string;
	private readonly cwd: string;
	private readonly hideThinkingBlock: boolean;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly transcript = new Container();
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private streamingComponent: AssistantMessageComponent | undefined;
	private session: AgentSession | undefined;

	private status = "starting side session…";
	private errorText: string | undefined;
	private scrollFromEnd = 0;
	private maxScroll = 0;
	private bodyHeight = 10;

	constructor(
		tui: TUI,
		theme: Theme,
		cwd: string,
		question: string,
		modelLabel: string,
		hideThinkingBlock: boolean,
		close: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.cwd = cwd;
		this.modelLabel = modelLabel;
		this.hideThinkingBlock = hideThinkingBlock;
		this.close = close;
		this.transcript.addChild(new UserMessageComponent(question, this.markdownTheme, 0));
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setStatus(status: string): void {
		this.status = status;
	}

	fail(message: string): void {
		this.errorText = message;
		this.tui.requestRender();
	}

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.markdownTheme,
						undefined,
						0,
					);
					this.transcript.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message, true);
				}
				break;
			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message, true);
					for (const content of event.message.content) {
						if (content.type === "toolCall") {
							this.ensureTool(content.name, content.id, content.arguments);
						}
					}
				}
				break;
			case "message_end":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message, false);
					for (const component of this.pendingTools.values()) component.setArgsComplete();
					this.streamingComponent = undefined;
				}
				break;
			case "tool_execution_start":
				if (!event.parentToolCallId) {
					this.ensureTool(event.toolName, event.toolCallId, event.args).markExecutionStarted();
				}
				break;
			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				component?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			}
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}
			default:
				break;
		}
		this.tui.requestRender();
	}

	private ensureTool(name: string, id: string, args: unknown): ToolExecutionComponent {
		let component = this.pendingTools.get(id);
		if (!component) {
			component = new ToolExecutionComponent(
				name,
				id,
				args,
				undefined,
				this.session?.getToolDefinition(name),
				this.tui,
				this.cwd,
			);
			this.transcript.addChild(component);
			this.pendingTools.set(id, component);
		} else {
			component.updateArgs(args);
		}
		return component;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		const step = this.bodyHeight;
		if (matchesKey(data, "up")) this.scrollFromEnd += 1;
		else if (matchesKey(data, "pageUp")) this.scrollFromEnd += step;
		else if (matchesKey(data, "down")) this.scrollFromEnd -= 1;
		else if (matchesKey(data, "pageDown")) this.scrollFromEnd -= step;
		else return;
		this.scrollFromEnd = Math.max(0, Math.min(this.maxScroll, this.scrollFromEnd));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const contentW = Math.max(20, width - 4);

		const rows = this.tui.terminal.rows;
		// chrome: top border, title, separator, footer, bottom border = 5 lines, plus margin slack.
		this.bodyHeight = Math.max(3, Math.min(40, rows - 9));

		const body = this.buildBody(contentW);
		this.maxScroll = Math.max(0, body.length - this.bodyHeight);
		this.scrollFromEnd = Math.min(this.scrollFromEnd, this.maxScroll);
		const end = body.length - this.scrollFromEnd;
		const start = Math.max(0, end - this.bodyHeight);
		const window = body.slice(start, end);
		while (window.length < this.bodyHeight) window.push("");

		const border = (text: string) => theme.fg("border", text);
		const pad = (content: string) => {
			const vis = visibleWidth(content);
			if (vis > contentW) return truncateToWidth(content, contentW);
			return content + " ".repeat(contentW - vis);
		};
		const row = (content: string) => `${border("│")} ${pad(content)} ${border("│")}`;

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(contentW + 2)}╮`));
		lines.push(row(`${theme.fg("accent", theme.bold("btw"))} ${theme.fg("dim", "· side question · read-only bash sandbox · shares main cache")}`));
		lines.push(row(theme.fg("border", "─".repeat(contentW))));
		for (const line of window) lines.push(row(line));
		const scrollHint = this.maxScroll > 0 ? " · ↑↓ scroll" : "";
		lines.push(row(theme.fg("dim", `${this.status} · esc close${scrollHint} · ${this.modelLabel}`)));
		lines.push(border(`╰${"─".repeat(contentW + 2)}╯`));
		return lines;
	}

	invalidate(): void {
		this.transcript.invalidate();
	}

	private buildBody(contentW: number): string[] {
		if (this.errorText) {
			return wrapTextWithAnsi(this.theme.fg("error", this.errorText), contentW);
		}
		const lines = this.transcript.render(contentW);
		if (lines.length === 0) {
			return [this.theme.fg("dim", this.status)];
		}
		return lines;
	}
}

async function runInteractive(
	ctx: ExtensionCommandContext,
	activeTools: string[],
	question: string,
	modelLabel: string,
	hideThinkingBlock: boolean,
): Promise<void> {
	let session: AgentSession | undefined;
	let cancelled = false;

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const close = () => {
				cancelled = true;
				session?.dispose();
				done(undefined);
			};
			const view = new BtwView(tui, theme, ctx.cwd, question, modelLabel, hideThinkingBlock, close);

			void (async () => {
				try {
					session = await createSideSession(ctx, activeTools);
					if (cancelled) {
						session.dispose();
						return;
					}
					view.setSession(session);
					const unsubscribe = session.subscribe((event) => view.handleEvent(event));
					try {
						view.setStatus("asking…");
						tui.requestRender();
						await session.prompt(question, { expandPromptTemplates: false });
					} finally {
						unsubscribe();
					}
					view.setStatus("done");
					tui.requestRender();
				} catch (error) {
					view.fail(error instanceof Error ? error.message : String(error));
				}
			})();

			return view;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "94%", maxHeight: "94%", margin: 1 },
		},
	);

	cancelled = true;
	session?.dispose();
}

export default function btw(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a side question in a read-only fork that reuses the main prompt cache",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}
			if (!ctx.model) {
				if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
				return;
			}

			const activeTools = pi.getActiveTools();
			try {
				if (ctx.mode === "tui") {
					await runInteractive(
						ctx,
						activeTools,
						question,
						`${ctx.model.provider}/${ctx.model.id}`,
						pi.getSettings().hideThinkingBlock ?? false,
					);
				} else {
					await runHeadless(ctx, activeTools, question);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`btw failed: ${message}`, "error");
				else process.stderr.write(`[btw] ${message}\n`);
			}
		},
	});
}
