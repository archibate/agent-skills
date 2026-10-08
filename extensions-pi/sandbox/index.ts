/**
 * sandbox extension: runs the agent's `bash` inside bubblewrap with a declared access policy, and
 * reviews calls that need more than this session's permissions.
 *
 * The `bash` tool gains an optional `sandbox` declaration (see policy.ts). Omitted, a command runs
 * read-only: writable only in the session scratchpad and $TMPDIR, no network, no connecting
 * to host Unix sockets (so no D-Bus, display, tmux, or editor IPC), host processes visible but not
 * signallable. The declaration is rendered under the command so a reviewer sees what each call
 * asked for.
 *
 * Review: the permissions (permissions.ts; --permissions, /permissions) are what runs without
 * review. A call beyond them goes to the reviewer (review.ts; --reviewer): deny, or manual in the
 * TUI. "Always" adds the call's grants to the session permissions. Permissions and review marks are
 * session entries. The agent's prompt does not mention any of this.
 *
 * Opt-in: the sandbox applies only when the launch asked for it, with `--enable-sandbox`,
 * `--permissions`, or `--reviewer` (see enable.ts). Otherwise the extension stays inert: `bash` is
 * pi's built-in, `job_start` is not redeclared, and no call is reviewed.
 *
 * User `!` commands are not sandboxed. The jobs extension (`job_start`) and `/btw` find this
 * extension through PROVIDER_CHANNEL and run without it when it is not loaded or not enabled.
 */

import { homedir } from "node:os";
import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { AUTO_REVIEW_ENTRY, DEFAULT_REVIEWER_MODEL, REVIEWER_MODEL_FLAG } from "./review-config.ts";
import { PermissionCeilings } from "./ceilings.ts";
import { sessionScratchpad } from "./scratchpad-path.ts";
import { ENABLE_SANDBOX_FLAG, sandboxRequested } from "./enable.ts";
import { isReviewMark, MARK_ENTRY, type ReviewMark, registerReviewMarks } from "./marks.ts";
import {
	type Allowance,
	assessCall,
	describeAllowance,
	excessGrants,
	isAllowance,
	NO_ACCESS,
	PERMISSION_PRESETS,
	PERMISSIONS_FLAG,
	parsePermissions,
	presetAllowance,
	unionAllowance,
} from "./permissions.ts";
import {
	canonicalPath,
	DEVICE_MODES,
	expandPath,
	isReadOnlyRequest,
	NETWORK_MODES,
	PROCESS_MODES,
	sandboxReferenceSchema,
} from "./policy.ts";
import {
	createReviewer,
	defaultReviewerName,
	denialReason,
	REVIEWER_FLAG,
	type Reviewer,
	type ReviewRequest,
} from "./review.ts";
import {
	PROVIDER_CHANNEL,
	prepareSandbox,
	SANDBOX_NOTE,
	type SandboxProvider,
	type SandboxRequest,
	warmSandbox,
} from "./sandbox.ts";
import { createSandboxBashDefinition, renderAllowanceBadge, withSandboxBadge } from "./tool.ts";

const PERMISSIONS_ENTRY = "sandbox-permissions";

export default function sandboxExtension(pi: ExtensionAPI): void {
	/** Read live: pi sets runtime flag values after loading, and a /btw side session has its own. */
	const requested = (): boolean =>
		sandboxRequested(
			{
				enable: pi.getFlag(ENABLE_SANDBOX_FLAG),
				permissions: pi.getFlag(PERMISSIONS_FLAG),
				reviewer: pi.getFlag(REVIEWER_FLAG),
			},
			process.argv,
		);

	pi.registerFlag(ENABLE_SANDBOX_FLAG, {
		type: "boolean",
		description: `Run bash and job_start in the access sandbox, and review calls beyond the permissions. Without this (or --${PERMISSIONS_FLAG} / --${REVIEWER_FLAG}), the sandbox stays off and pi's normal tools run.`,
	});
	pi.registerFlag(PERMISSIONS_FLAG, {
		type: "string",
		description: `What runs without review: ${PERMISSION_PRESETS.join(" or ")}, or a JSON sandbox object such as '{"writableLocations":["src"]}'. Default: the git work tree is writable, network fetch-only.`,
	});
	pi.registerFlag(REVIEWER_FLAG, {
		type: "string",
		description: `Who decides calls beyond the permissions: deny, manual, auto, or auto-manual. Manual modes need the TUI. Default: auto-manual in the TUI, deny otherwise.`,
	});
	pi.registerFlag(REVIEWER_MODEL_FLAG, {
		type: "string",
		description: `Model for automatic review, as provider/model. Default: ${DEFAULT_REVIEWER_MODEL}.`,
	});

	let allowance: Allowance = NO_ACCESS;
	let reviewer: Reviewer = createReviewer("deny", "print");
	/** Startup problems; while set, calls beyond read-only are denied and the reason names them. */
	let configError: string | undefined;
	/** Set by restrict(): fixed permissions for this runtime, e.g. a /btw side session. */
	let restricted: string | undefined;
	let flagApplied = false;
	let cwd = process.cwd();
	let statusUI: ExtensionContext["ui"] | undefined;
	let sessionEpoch = 0;
	let ceilingEpoch = 0;
	let allowanceRevision = 0;
	let sessionId: string | undefined;
	let closed = false;
	let reviewAbort = new AbortController();
	const marks = new Map<string, ReviewMark>();
	const ceilings = new PermissionCeilings(() => {
		ceilingEpoch++;
		invalidateReviews();
		updateStatus();
	});

	const home = homedir();

	function invalidateReviews(sessionChanged = false): void {
		if (sessionChanged) sessionEpoch++;
		reviewAbort.abort();
		reviewAbort = new AbortController();
		reviewer.reset?.();
	}

	function restore(ctx: ExtensionContext, applyStartupFlag = false): void {
		invalidateReviews(true);
		reviewer.dispose?.();
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		closed = false;
		statusUI = ctx.mode === "tui" ? ctx.ui : undefined;
		marks.clear();
		let stored: Allowance | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === PERMISSIONS_ENTRY && isAllowance(entry.data)) stored = entry.data;
			if (entry.customType === MARK_ENTRY) {
				const { toolCallId, mark } = (entry.data ?? {}) as { toolCallId?: unknown; mark?: unknown };
				if (typeof toolCallId === "string" && isReviewMark(mark)) {
					marks.set(toolCallId, mark);
				}
			}
		}
		const errors: string[] = [];
		const flag = pi.getFlag(PERMISSIONS_FLAG);
		try {
			if (restricted !== undefined) allowance = parsePermissions(restricted, cwd, home);
			else if (typeof flag === "string" && flag !== "" && !flagApplied && applyStartupFlag) {
				// The flag replaces stored permissions once, at startup; /permissions edits after that
				// survive /reload. A fork child given --permissions read-only is read-only.
				allowance = parsePermissions(flag, cwd, home);
				flagApplied = true;
				pi.appendEntry(PERMISSIONS_ENTRY, allowance);
			} else if (stored) allowance = stored;
			else if (typeof flag === "string" && flag !== "") allowance = parsePermissions(flag, cwd, home);
			else allowance = presetAllowance("default", cwd, home);
		} catch (error) {
			allowance = presetAllowance("read-only", cwd, home);
			errors.push(error instanceof Error ? error.message : String(error));
		}
		const name = restricted !== undefined ? "deny" : pi.getFlag(REVIEWER_FLAG);
		try {
			const model = pi.getFlag(REVIEWER_MODEL_FLAG);
			const epoch = sessionEpoch;
			reviewer = createReviewer(typeof name === "string" && name !== "" ? name : defaultReviewerName(ctx.mode), ctx.mode, {
				model: typeof model === "string" && model !== "" ? model : DEFAULT_REVIEWER_MODEL,
				record: (record) => { if (epoch === sessionEpoch) pi.appendEntry(AUTO_REVIEW_ENTRY, record); },
			});
		} catch (error) {
			reviewer = createReviewer("deny", ctx.mode);
			errors.push(error instanceof Error ? error.message : String(error));
		}
		configError = errors.length > 0 ? errors.join("; ") : undefined;
		updateStatus();
		if (configError) throw new Error(`sandbox: ${configError}. Calls beyond read-only are denied.`);
	}

	function effectiveAllowance(): Allowance {
		return ceilings.effective(configError ? presetAllowance("read-only", cwd, home) : allowance);
	}

	function ceilingNote(): string {
		return ceilings.names.length ? ` (limited by ${ceilings.names.join(", ")})` : "";
	}

	function updateStatus(): void {
		if (!statusUI) return;
		const badge = renderAllowanceBadge(effectiveAllowance(), statusUI.theme) + statusUI.theme.fg("warning", ceilingNote());
		statusUI.setStatus("sandbox-permissions", configError ? `${badge} ${statusUI.theme.fg("warning", "(config error)")}` : badge);
	}

	function setAllowance(next: Allowance): void {
		allowanceRevision++;
		invalidateReviews();
		allowance = next;
		pi.appendEntry(PERMISSIONS_ENTRY, allowance);
		updateStatus();
	}

	function setMark(toolCallId: string, mark: ReviewMark): void {
		marks.set(toolCallId, mark);
		pi.appendEntry(MARK_ENTRY, { toolCallId, mark });
	}

	registerReviewMarks(pi, (toolCallId) => marks.get(toolCallId));
	// After the marks resolver so review marks follow the access badge. Jobs owns its base
	// rendering; sandbox only decorates it while enabled.
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		return toolName === "job_start" && requested() && base?.renderCall
			? { ...base, renderCall: withSandboxBadge(base.renderCall) }
			: base;
	});

	// Also guard the launch path used by jobs/btw, not only the earlier tool_call review hook.
	const prepare: typeof prepareSandbox = async (request, workdir) => {
		const admitted = reviewAbort.signal;
		const scratchpad = sessionScratchpad(sessionId);
		const check = () => {
			if (admitted.aborted) throw new Error("Sandbox permissions changed before launch; retry the command");
			const reason = ceilings.denial({ toolName: "bash", input: { sandbox: request }, cwd: workdir, home, scratchpad });
			if (reason) throw new Error(reason);
		};
		check();
		const prepared = await prepareSandbox(request, workdir, scratchpad);
		try { check(); }
		catch (error) { await prepared.dispose(); throw error; }
		return {
			...prepared,
			shell: (base) => { check(); return prepared.shell(base); },
			env: (base) => { check(); return prepared.env(base); },
		};
	};

	const provider: SandboxProvider = {
		note: SANDBOX_NOTE,
		parameter: sandboxReferenceSchema,
		prepare: (request, workdir) => prepare(request as SandboxRequest | undefined, workdir),
		isReadOnly: (request) => isReadOnlyRequest(request as SandboxRequest | undefined),
		restrict(permissions) {
			const next = parsePermissions(permissions, cwd, home);
			allowanceRevision++;
			invalidateReviews(true);
			reviewer.dispose?.();
			allowance = next;
			restricted = permissions;
			reviewer = createReviewer("deny", "print");
			configError = undefined;
			updateStatus();
		},
		pushCeiling(name, permissions) {
			if (!name.trim()) throw new Error("A temporary permission restriction needs a name");
			return ceilings.add(name, parsePermissions(permissions, cwd, home));
		},
		carryPermissions() {
			const snapshot = structuredClone(allowance);
			const owner = sessionId;
			const revision = allowanceRevision;
			let committed = false;
			return () => {
				if (committed) return;
				if (closed || sessionId !== owner || allowanceRevision !== revision) {
					throw new Error("Permissions changed during handoff; request approval again");
				}
				// Navigation reconstructs historical permissions. An explicit execution handoff
				// carries the user's current choice instead, without overwriting concurrent edits.
				if (JSON.stringify(allowance) !== JSON.stringify(snapshot)) setAllowance(snapshot);
				committed = true;
			};
		},
	};
	pi.events.on(PROVIDER_CHANNEL, (reply) => {
		if (typeof reply === "function" && requested()) (reply as (provider: SandboxProvider) => void)(provider);
	});

	pi.on("session_start", (event, ctx) => {
		if (!requested()) return;
		// Declared here rather than at load so a disabled sandbox leaves pi's built-in bash in place.
		pi.registerTool(createSandboxBashDefinition(ctx.cwd, prepare));
		warmSandbox();
		restore(ctx, event.reason === "startup");
	});
	pi.on("session_tree", (_event, ctx) => {
		if (requested()) restore(ctx);
	});
	pi.on("session_shutdown", () => {
		closed = true;
		invalidateReviews(true);
		reviewer.dispose?.();
	});

	// One review at a time; each re-checks the permissions, which an earlier "always" may have widened.
	let queue: Promise<unknown> = Promise.resolve();

	pi.on("tool_call", async (event, ctx) => {
		if (!requested()) return undefined;
		const call = {
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			cwd: ctx.cwd,
			home,
			scratchpad: sessionScratchpad(sessionId),
		};
		const hardDenial = ceilings.denial(call);
		if (hardDenial) return { block: true, reason: hardDenial };
		const effective = effectiveAllowance;
		if (assessCall(effective(), call).kind === "allow") return undefined;
		const epoch = sessionEpoch;
		const limits = ceilingEpoch;
		const turn = queue.then(async () => {
			if (ctx.signal?.aborted || epoch !== sessionEpoch || limits !== ceilingEpoch) return { block: true, reason: "Review cancelled: the session or restrictions changed, or the turn was aborted." };
			const hardDenial = ceilings.denial(call);
			if (hardDenial) return { block: true, reason: hardDenial };
			const assessment = assessCall(effective(), call);
			if (assessment.kind === "allow") return undefined;
			if (assessment.kind === "invalid") return { block: true, reason: assessment.message };
			const instructions = ctx.getSystemPrompt();
			const fingerprint = JSON.stringify(call.input);
			const assessmentFingerprint = JSON.stringify(assessment);
			const signal = AbortSignal.any([reviewAbort.signal, ...(ctx.signal ? [ctx.signal] : [])]);
			const reviewContext: ExtensionContext = Object.create(ctx);
			Object.defineProperty(reviewContext, "signal", { value: signal });
			const request: ReviewRequest = {
				toolCallId: event.toolCallId,
				permissions: describeAllowance(effective()),
				toolDescription: pi.getAllTools().find((tool) => tool.name === call.toolName)?.description,
				resolvedPath: ["write", "edit"].includes(call.toolName) && typeof call.input.path === "string" ? canonicalPath(expandPath(call.input.path.replace(/^@/, ""), ctx.cwd, home)) : undefined,
				resolvedAccess: ["bash", "job_start"].includes(call.toolName) ? assessment.always?.policy : undefined,
				toolName: call.toolName,
				input: call.input,
				cwd: ctx.cwd,
				subject: assessment.subject,
				excess: assessment.excess,
				always: assessment.always ? alwaysLabel(allowance, assessment.always) : undefined,
			};
			const active = configError ? createReviewer("deny", ctx.mode) : reviewer;
			const verdict = await active.review(request, reviewContext);
			if (signal.aborted || epoch !== sessionEpoch || instructions !== ctx.getSystemPrompt() || fingerprint !== JSON.stringify(call.input) || assessmentFingerprint !== JSON.stringify(assessCall(effective(), call))) {
				return { block: true, reason: "Review cancelled: the session, permissions, or proposed call changed. Reassess the current request." };
			}
			if (verdict.kind === "approve" || verdict.kind === "always") {
				if (verdict.kind === "always" && assessment.always) setAllowance(unionAllowance(allowance, assessment.always));
				setMark(event.toolCallId, verdict.kind === "always" ? "always" : verdict.source === "auto" ? "auto-approved" : "approved");
				return undefined;
			}
			if (active.name !== "deny") setMark(event.toolCallId, verdict.source === "auto" ? "auto-denied" : "denied");
			const reason = denialReason(request, verdict, active.name, describeAllowance(effective()));
			return { block: true, reason: configError ? `${reason} (${configError})` : reason };
		});
		queue = turn.catch(() => {});
		return turn;
	});

	pi.registerCommand("permissions", {
		description: "Show or edit what runs without review in this session",
		handler: async (args, ctx) => {
			if (!requested()) {
				ctx.ui.notify(
					`The sandbox is off for this session. Start pi with --${ENABLE_SANDBOX_FLAG}, --${PERMISSIONS_FLAG}, or --${REVIEWER_FLAG} to use it.`,
					"info",
				);
				return;
			}
			statusUI = ctx.mode === "tui" ? ctx.ui : undefined;
			await permissionsCommand(args.trim(), ctx);
		},
	});

	async function permissionsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (restricted !== undefined) {
			ctx.ui.notify(`Permissions are fixed in this session: ${describeAllowance(allowance)}`, "info");
			return;
		}
		if (args !== "") {
			try {
				setAllowance(parsePermissions(args, ctx.cwd, home));
				ctx.ui.notify(`Permissions: ${describeAllowance(allowance)}${ceilingNote()}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}
		if (!ctx.hasUI) return;
		await editPermissions(ctx);
	}

	async function editPermissions(ctx: ExtensionCommandContext): Promise<void> {
		let selected = 0;
		for (;;) {
			const p = allowance.policy;
			const onOff = (value: boolean) => (value ? "on" : "off");
			const list = (paths: string[]) => (paths.length > 0 ? paths.join(", ") : "none");
			const tools = allowance.tools === "all" ? "all" : list(allowance.tools);
			const rows: Array<[string, () => Promise<void>]> = [
				[`Writable locations: ${list(p.writable)}`, () => editPaths(ctx, "writable", "Writable location")],
				[`Network: ${p.network}`, () => pickMode(ctx, "Network", NETWORK_MODES, (network) => ({ network }))],
				[`Sockets: ${list(p.sockets)}`, () => editPaths(ctx, "sockets", "Socket or socket directory")],
				[`Session and system bus: ${onOff(p.bus)}`, async () => setPolicy({ bus: !p.bus })],
				[`Display: ${onOff(p.display)}`, async () => setPolicy({ display: !p.display })],
				[`Processes: ${p.process}`, () => pickMode(ctx, "Processes", PROCESS_MODES, (process) => ({ process }))],
				[`Devices: ${p.device}`, () => pickMode(ctx, "Devices", DEVICE_MODES, (device) => ({ device }))],
				[`Other tools: ${tools}`, () => editTools(ctx)],
				[`Skip sandbox (review off): ${onOff(p.skip)}`, async () => setPolicy({ skip: !p.skip })],
			];
			const choice = await selectPermissionRow(
				ctx,
				`Permissions: what runs without review (reviewer: ${reviewer.name})${ceilingNote()}`,
				rows.map(([label]) => label),
				selected,
			);
			if (choice === undefined) return;
			if (typeof choice === "string") {
				setAllowance(presetAllowance(choice, ctx.cwd, home));
				continue;
			}
			const row = rows[choice];
			if (!row) return;
			selected = choice;
			await row[1]();
		}
	}

	function setPolicy(change: Partial<Allowance["policy"]>): void {
		setAllowance({ ...allowance, policy: { ...allowance.policy, ...change } });
	}

	async function pickMode<T extends string>(
		ctx: ExtensionCommandContext,
		title: string,
		modes: readonly T[],
		change: (mode: T) => Partial<Allowance["policy"]>,
	): Promise<void> {
		const choice = await ctx.ui.select(title, [...modes]);
		if (choice) setPolicy(change(choice as T));
	}

	async function editPaths(ctx: ExtensionCommandContext, field: "writable" | "sockets", what: string): Promise<void> {
		const paths = allowance.policy[field];
		const add = `Add ${what.toLowerCase()}…`;
		const choice = await ctx.ui.select(`${what}s (select one to remove it)`, [add, ...paths]);
		if (!choice) return;
		if (choice !== add) {
			setPolicy({ [field]: paths.filter((path) => path !== choice) });
			return;
		}
		const input = (await ctx.ui.input(what, "path; ~ and relative paths resolve against the cwd"))?.trim();
		if (!input) return;
		const path = canonicalPath(expandPath(input, ctx.cwd, home));
		if (path === "/") {
			ctx.ui.notify('"/" cannot be pre-approved; use "Skip sandbox" instead', "error");
			return;
		}
		setPolicy({ [field]: [...new Set([...paths, path])] });
	}

	async function editTools(ctx: ExtensionCommandContext): Promise<void> {
		const all = "Allow all other tools";
		const none = "Review all other tools";
		const current = allowance.tools === "all" ? [] : allowance.tools;
		const choice = await ctx.ui.select("Other tools (select one to remove it)", [all, none, ...current]);
		if (!choice) return;
		const tools = choice === all ? "all" : choice === none ? [] : current.filter((tool) => tool !== choice);
		setAllowance({ ...allowance, tools });
	}
}

type PermissionChoice = number | (typeof PERMISSION_PRESETS)[number];

/** The built-in select dialog always starts at row zero; keep the TUI cursor by row, not label. */
async function selectPermissionRow(
	ctx: ExtensionCommandContext,
	title: string,
	labels: string[],
	selected: number,
): Promise<PermissionChoice | undefined> {
	if (ctx.mode !== "tui") {
		const options = [...labels, ...PERMISSION_PRESETS.map((preset) => `Reset to ${preset}`)];
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) return undefined;
		const index = options.indexOf(choice);
		return index < labels.length ? index : PERMISSION_PRESETS[index - labels.length];
	}
	return ctx.ui.custom<PermissionChoice | undefined>((tui, theme, kb, done) => {
		const container = new Container();
		const border = () => new DynamicBorder((text) => theme.fg("border", text));
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		const list = new SelectList(labels.map((label, index) => ({ label, value: String(index) })), labels.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.setSelectedIndex(selected);
		list.onSelect = (item) => done(Number(item.value));
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Spacer(1));
		const hints = `↑↓ navigate  ${kb.getKeys("tui.select.confirm").join("/")} select  ${kb.getKeys("tui.select.cancel").join("/")} cancel  d reset to default  r reset to read-only`;
		container.addChild(new Text(theme.fg("dim", hints), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(border());
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data) {
				if (data === "d" || data === "r") {
					done(data === "d" ? "default" : "read-only");
					return;
				}
				list.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data === "\n" ? "\r" : data);
				tui.requestRender();
			},
		};
	});
}

/** What "always" adds beyond `current`, for the modal. */
function alwaysLabel(current: Allowance, grant: Allowance): string {
	const added = excessGrants(grant.policy, current.policy);
	if (grant.tools === "all" && current.tools !== "all") added.push("every other tool");
	else if (Array.isArray(grant.tools) && current.tools !== "all") {
		const tools = grant.tools.filter((tool) => !(current.tools as string[]).includes(tool));
		if (tools.length > 0) added.push(`tools ${tools.join(", ")}`);
	}
	return added.join("; ") || "nothing new";
}
