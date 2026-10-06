import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOfoxProvider, PROVIDER_ID, REQUEST_TIMEOUT_MS } from "./provider.ts";

export default function (pi: ExtensionAPI): void {
	const provider = createOfoxProvider();
	// The host runtime owns credentials, cached catalogs, and live refreshes.
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
