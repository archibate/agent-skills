// Point tests at an installed Pi without installing dependencies into the extension.
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (process.env.PI_SDK_PATH) {
	const sdkUrl = pathToFileURL(process.env.PI_SDK_PATH);
	const require = createRequire(sdkUrl);
	const resolved = (id) => pathToFileURL(require.resolve(id)).href;
	// Pi's extension loader aliases these to its own copies; mirror that for tests.
	const aliases = new Map([
		["@earendil-works/pi-coding-agent", sdkUrl.href],
		["@earendil-works/pi-tui", resolved("@earendil-works/pi-tui")],
		...["typebox", "typebox/compile", "typebox/value"].map((id) => [id, resolved(id)]),
	]);
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const url = aliases.get(specifier);
			return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
		},
	});
}
