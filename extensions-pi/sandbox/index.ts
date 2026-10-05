/**
 * sandbox extension: runs the agent's `bash` inside bubblewrap with a declared access policy.
 *
 * The `bash` tool gains an optional `sandbox` declaration (see policy.ts). Omitted, a command runs
 * read-only: writable only in the session scratchpad and $TMPDIR, no network, no connecting
 * to host Unix sockets (so no D-Bus, display, tmux, or editor IPC), host processes visible but not
 * signallable. The declaration
 * is rendered under the command so a reviewer sees what each call asked for. Stage 1 grants
 * whatever is declared; review gating comes later.
 *
 * `--sandbox-ceiling` (ceiling.ts) bounds every tool call of a headless run such as a subagent.
 *
 * User `!` commands are not sandboxed. The jobs extension (`job_start`) and `/btw` find this
 * extension through PROVIDER_CHANNEL and run without it when it is not loaded.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CEILING_FLAG, type Ceiling, ceilingViolation, parseCeiling } from "./ceiling.ts";
import { isReadOnlyRequest, sandboxReferenceSchema } from "./policy.ts";
import {
	PROVIDER_CHANNEL,
	prepareSandbox,
	SANDBOX_NOTE,
	type SandboxProvider,
	type SandboxRequest,
	warmSandbox,
} from "./sandbox.ts";
import { createSandboxBashDefinition } from "./tool.ts";

export default function sandboxExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSandboxBashDefinition(process.cwd()));

	const provider: SandboxProvider = {
		note: SANDBOX_NOTE,
		parameter: sandboxReferenceSchema,
		prepare: (request, cwd) => prepareSandbox(request as SandboxRequest | undefined, cwd),
		isReadOnly: (request) => isReadOnlyRequest(request as SandboxRequest | undefined),
	};
	pi.events.on(PROVIDER_CHANNEL, (reply) => {
		if (typeof reply === "function") (reply as (provider: SandboxProvider) => void)(provider);
	});

	pi.registerFlag(CEILING_FLAG, {
		type: "string",
		description:
			'Most access tool calls in this run may use: "read-only", or a JSON sandbox object such as \'{"writableLocations":["src"]}\'. Calls beyond it are blocked.',
	});
	// Parsed once per cwd. An invalid value fails closed: every call that is not read-only is blocked.
	let ceiling: { cwd: string; value: Ceiling | Error } | undefined;
	pi.on("tool_call", (event, ctx) => {
		const flag = pi.getFlag(CEILING_FLAG);
		if (typeof flag !== "string" || flag === "") return undefined;
		if (ceiling?.cwd !== ctx.cwd) {
			let value: Ceiling | Error;
			try {
				value = parseCeiling(flag, ctx.cwd, homedir());
			} catch (error) {
				value = error instanceof Error ? error : new Error(String(error));
			}
			ceiling = { cwd: ctx.cwd, value };
		}
		const active = ceiling.value instanceof Error ? parseCeiling("read-only", ctx.cwd, homedir()) : ceiling.value;
		const reason = ceilingViolation(active, {
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			cwd: ctx.cwd,
			home: homedir(),
			scratchpad: process.env.PI_SCRATCHPAD_DIR,
		});
		if (!reason) return undefined;
		return { block: true, reason: ceiling.value instanceof Error ? `${ceiling.value.message}. ${reason}` : reason };
	});

	pi.on("session_start", () => {
		warmSandbox();
	});
}
