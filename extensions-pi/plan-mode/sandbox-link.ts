import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxProvider } from "../sandbox/sandbox.ts";

const CHANNEL = "archibate.sandbox:get";

/** Optional integration: the sandbox owns enforcement; planning owns the restriction's lifetime. */
export function planningSandbox(pi: ExtensionAPI): {
	update(active: boolean, planPath?: string): void;
	carryPermissions(): () => void;
	dispose(): void;
} {
	let provider: SandboxProvider | undefined;
	let permissions: string | undefined;
	let release: (() => void) | undefined;
	function dispose(): void {
		release?.();
		release = undefined;
		provider = undefined;
		permissions = undefined;
	}
	return {
		dispose,
		carryPermissions() {
			if (!provider) return () => {};
			if (typeof provider.carryPermissions !== "function") throw new Error("Reload the sandbox extension before checkpoint execution");
			return provider.carryPermissions();
		},
		update(active, planPath) {
			if (!active) { dispose(); return; }
			let found: SandboxProvider | undefined;
			// Event-bus listeners swallow exceptions. Call the throwing API outside the reply.
			pi.events.emit(CHANNEL, (value: SandboxProvider) => { found = value; });
			if (!found) { dispose(); return; } // Disabled/absent sandbox remains opt-in.
			if (typeof found.pushCeiling !== "function") throw new Error("Reload the sandbox extension to enforce planning permissions");
			const next = JSON.stringify({
				writableLocations: planPath ? [dirname(planPath)] : [],
				networkAccess: "fetch-only",
			});
			if (found === provider && next === permissions) return;
			const nextRelease = found.pushCeiling("plan mode", next);
			release?.();
			provider = found;
			permissions = next;
			release = nextRelease;
		},
	};
}
