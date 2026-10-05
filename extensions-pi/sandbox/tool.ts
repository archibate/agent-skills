/**
 * The sandboxed `bash` tool: pi's own bash definition (output handling, truncation, renderers)
 * with a `sandbox` declaration added and execution routed through bwrap. Exported so `/btw` can
 * declare the identical tool and keep its prompt-cache prefix.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type BashOperations,
	createBashToolDefinition,
	getShellConfig,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Allowance } from "./permissions.ts";
import {
	describeRequest,
	execShell,
	type PreparedSandbox,
	prepareSandbox,
	SANDBOX_NOTE,
	sandboxSchema,
} from "./sandbox.ts";

function sandboxOperations(prepared: PreparedSandbox): BashOperations {
	return {
		exec: (command, cwd, options) =>
			execShell(prepared.shell(getShellConfig()), command, cwd, {
				...options,
				env: prepared.env(options.env ?? process.env),
				reapGroup: prepared.reapGroup,
			}),
	};
}

/** Theme subset used for the badge; matches pi's Theme.fg. */
interface BadgeTheme {
	fg(color: "muted" | "accent" | "warning" | "dim", text: string): string;
}

export function renderBadge(request: unknown, theme: BadgeTheme): string {
	const parts = describeRequest(request).map((part) => theme.fg(part.tone, part.text));
	return `${theme.fg("dim", "⛶")} ${parts.join(theme.fg("dim", " · "))}`;
}

/** Session permissions, using the call badge's access labels and colours. */
export function renderAllowanceBadge(allowance: Allowance, theme: BadgeTheme): string {
	const p = allowance.policy;
	const badge = renderBadge({
		writableLocations: p.writable,
		networkAccess: p.network,
		socketAccess: p.sockets,
		sessionBusAccess: p.bus,
		displayAccess: p.display,
		processAccess: p.process,
		deviceAccess: p.device,
		dangerouslySkipSandbox: p.skip,
	}, theme);
	if (p.skip || (Array.isArray(allowance.tools) && allowance.tools.length === 0)) return badge;
	const tools = allowance.tools === "all" ? "all" : allowance.tools.join(", ");
	return `${badge}${theme.fg("dim", " · ")}${theme.fg("accent", `tools ${tools}`)}`;
}

/** Shared command + access badge for foreground bash and background job_start calls. */
export const renderSandboxCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
	const input = (args ?? {}) as { command?: unknown; timeout?: unknown; sandbox?: unknown };
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const command = typeof input.command === "string" && input.command ? input.command : "...";
	const timeout = typeof input.timeout === "number" ? theme.fg("muted", ` (timeout ${input.timeout}s)`) : "";
	text.setText(`${theme.fg("toolTitle", theme.bold(`$ ${command}`))}${timeout}\n${renderBadge(input.sandbox, theme)}`);
	return text;
};

const HINTS: Array<{ pattern: RegExp; applies: (p: PreparedSandbox) => boolean; text: string }> = [
	{
		pattern: /Read-only file system|EROFS|只读文件系统/,
		applies: (p) => !p.policy.skip,
		text: "The sandbox filesystem is read-only outside the scratchpad, $TMPDIR, and declared locations (/tmp included). Put temporary files in $PI_SCRATCHPAD_DIR or $TMPDIR; if the command must write elsewhere, retry with sandbox.writableLocations listing the narrowest paths it writes.",
	},
	{
		pattern:
			/Could not resolve host|Temporary failure in name resolution|Network is unreachable|Name or service not known|getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH|域名解析暂时失败|网络不可达|未知的名称或服务/,
		applies: (p) => !p.policy.skip && p.policy.network === "disable",
		text: 'The sandbox has no network. If the command needs it, retry with sandbox.networkAccess "fetch-only" for downloads and read-only queries, or "full" when required.',
	},
	{
		pattern: /cannot open display|Can't open display|Failed to connect to Wayland|WAYLAND_DISPLAY|no display/i,
		applies: (p) => !p.policy.skip && !p.policy.display,
		text: "The sandbox hides the display. If the command needs a GUI or input tools, retry with sandbox.displayAccess.",
	},
	{
		pattern: /Failed to connect to (the )?bus|DBUS_SESSION_BUS_ADDRESS|org\.freedesktop\.DBus/,
		applies: (p) => !p.policy.skip && !p.policy.bus,
		text: "The sandbox hides D-Bus. If the command needs it, retry with sandbox.sessionBusAccess.",
	},
];

/** One-line recovery hints for a failed call, derived from its output and the policy in force. */
export function sandboxHints(output: string, prepared: PreparedSandbox): string[] {
	const hints = HINTS.filter((hint) => hint.applies(prepared) && hint.pattern.test(output)).map((hint) => hint.text);
	const denied = prepared.report().network?.denied ?? [];
	if (denied.length > 0) {
		hints.push(
			`The fetch-only proxy blocked ${denied.map((d) => `${d.host} (${d.reason})`).join(", ")}. Local and private addresses need networkAccess "full".`,
		);
	}
	return hints;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text)
		.join("\n");
}

export function createSandboxBashDefinition(cwd: string): ToolDefinition {
	const base = createBashToolDefinition(cwd);
	const parameters = Type.Object({ ...base.parameters.properties, sandbox: Type.Optional(sandboxSchema) });
	const definition: ToolDefinition<typeof parameters> = {
		...(base as unknown as ToolDefinition<typeof parameters>),
		description: `${base.description} ${SANDBOX_NOTE}`,
		parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { sandbox, ...input } = params;
			const workdir = ctx?.cwd || cwd;
			const prepared = await prepareSandbox(sandbox, workdir);
			try {
				const inner = createBashToolDefinition(
					workdir,
					prepared.policy.skip ? undefined : { operations: sandboxOperations(prepared) },
				);
				const result = await inner.execute(toolCallId, input, signal, onUpdate, ctx);
				const report = prepared.report();
				const details = report.network ? { ...(result.details ?? {}), sandbox: report } : result.details;
				const hints = result.isError ? sandboxHints(textOf(result), prepared) : [];
				return {
					...result,
					details,
					content: hints.length ? [...result.content, { type: "text" as const, text: hints.join("\n") }] : result.content,
				};
			} finally {
				await prepared.dispose();
			}
		},
		renderCall(args, theme, context) {
			// pi's shell renderer keeps its timer in context.state; mirror it so renderResult's
			// "Took Ns" line keeps working, then show the call line plus the access badge.
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			return renderSandboxCall(args, theme, context);
		},
	};
	return definition as unknown as ToolDefinition;
}
