/**
 * Show the footer's session cost in RMB instead of USD.
 *
 * The built-in footer hardcodes the cost as `$<total>` with no formatting
 * hook and no setting to hide it, so there is no supported way to replace only
 * that segment. Instead this wraps the public `FooterComponent.prototype.render`
 * and rewrites the `$…` token on the stats line (index 1) into `¥…`, leaving
 * the rest of the default footer untouched.
 *
 * Caveat: this reaches into an internal renderer. If upstream changes the
 * footer layout the replacement simply stops matching; it will not crash.
 * `/session` and other cost displays are unaffected and still show USD.
 *
 * The rate is a rough constant - update it when it drifts too far from spot.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";

const USD_TO_RMB = 6.7;

const PATCHED = Symbol.for("pi.rmb-cost.patched");

export default function (pi: ExtensionAPI) {
	const proto = FooterComponent.prototype as unknown as {
		render(width: number): string[];
		[PATCHED]?: boolean;
	};
	if (proto[PATCHED]) return; // survive /reload without double-wrapping

	proto[PATCHED] = true;
	const originalRender = proto.render;

	proto.render = function (width: number): string[] {
		const lines = originalRender.call(this, width);
		// lines[0] is the cwd line, lines[1] is the token/cost stats line.
		// Cost is always `$` + 3 decimals, optionally followed by " (sub)".
		if (lines[1]) {
			lines[1] = lines[1].replace(/\$(\d+\.\d{3})( \(sub\))?/g, (_match, usd: string, sub: string | undefined) => {
				return `¥${(Number(usd) * USD_TO_RMB).toFixed(2)}${sub ?? ""}`;
			});
		}
		return lines;
	};
}
