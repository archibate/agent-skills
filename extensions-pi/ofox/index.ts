import { realpathSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOfoxProvider, PROVIDER_ID, REQUEST_TIMEOUT_MS } from "./provider.ts";

function isPiCli(): boolean {
	try {
		const entry = realpathSync(process.argv[1]);
		return ["dist/cli.js", "dist/bundle/cli.js"].some((path) => entry === join(getPackageDir(), path));
	} catch {
		return false;
	}
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const provider = createOfoxProvider();
	// Startup and --list-models only restore provider caches. Bootstrap through
	// the public runtime so auth resolution and locked models-store persistence
	// are identical to Pi's later refreshes; only Ofox may access the network.
	// SDK embeddings can supply independent credentials/stores. They must use
	// their own runtime.refresh(); never open default user storage on their behalf.
	if (isPiCli()) {
		try {
			const runtime = await ModelRuntime.create({ refreshOnCreate: false });
			runtime.registerNativeProvider(provider);
			const result = await runtime.refresh({
				providers: [PROVIDER_ID], allowNetwork: process.env.PI_OFFLINE === undefined,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 2000),
			});
			if (result.aborted || result.errors.size) {
				console.error("Ofox: catalog discovery failed; using the last successful catalog, if available.");
			}
		} catch {
			console.error("Ofox: catalog initialization failed; the provider remains registered for retry.");
		}
	}
	pi.registerProvider(provider);
	pi.registerCommand("ofox-refresh", {
		description: "Refresh Ofox's model catalog now",
		handler: async (_args, ctx) => {
			if (process.env.PI_OFFLINE !== undefined) {
				ctx.ui.notify("Ofox catalog refresh is disabled in offline mode.", "warning");
				return;
			}
			if (!await ctx.modelRegistry.getProviderAuth(PROVIDER_ID)) {
				ctx.ui.notify("Set OFOX_API_KEY or use /login ofox before refreshing models.", "warning");
				return;
			}
			const result = await ctx.modelRegistry.refresh({
				providers: [PROVIDER_ID], allowNetwork: true, force: true,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 2000),
			});
			if (result.aborted || result.errors.size) {
				ctx.ui.notify("Ofox catalog refresh failed; the previous catalog was retained.", "error");
			} else {
				ctx.ui.notify(`Ofox: ${provider.getModels().length} chat models available.`, "info");
			}
		},
	});
}
