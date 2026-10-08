import { assessCall, intersectAllowance, type Allowance, type ToolCall } from "./permissions.ts";

/** Runtime-only restrictions, independent of persistent pre-approval and reviewer settings. */
export class PermissionCeilings {
	private readonly limits = new Map<symbol, { name: string; allowance: Allowance }>();
	private readonly changed: () => void;

	constructor(changed: () => void) { this.changed = changed; }

	get names(): string[] { return [...new Set([...this.limits.values()].map((limit) => limit.name))]; }

	/** The returned handle releases only this restriction, even when names are reused. */
	add(name: string, allowance: Allowance): () => void {
		const key = Symbol(name);
		this.limits.set(key, { name, allowance });
		this.changed();
		return () => { if (this.limits.delete(key)) this.changed(); };
	}

	effective(base: Allowance): Allowance {
		let effective = base;
		for (const limit of this.limits.values()) effective = intersectAllowance(effective, limit.allowance);
		return effective;
	}

	/** Hard rejection before review, including the normally pre-approved unsandboxed subagent route. */
	denial(call: ToolCall): string | undefined {
		const rawCall = call.toolName === "job_start" ? { ...call, toolName: "bash" } : call;
		for (const limit of this.limits.values()) {
			const assessment = assessCall(limit.allowance, rawCall);
			if (assessment.kind === "allow") continue;
			const reason = assessment.kind === "invalid" ? assessment.message : `${call.toolName} needs ${assessment.excess.join(", ")}`;
			return `Blocked by temporary restriction ${JSON.stringify(limit.name)}: ${reason}. This restriction cannot be overridden by review.`;
		}
		return undefined;
	}
}
