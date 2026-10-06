// Point tests at an installed Pi without installing dependencies into the extension.
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

if (process.env.PI_SDK_PATH) {
	const sdkUrl = pathToFileURL(process.env.PI_SDK_PATH);
	const require = createRequire(sdkUrl);
	const tuiUrl = pathToFileURL(require.resolve("@earendil-works/pi-tui")).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@earendil-works/pi-coding-agent") return { url: sdkUrl.href, shortCircuit: true };
			if (specifier === "@earendil-works/pi-tui") return { url: tuiUrl, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	});
}
