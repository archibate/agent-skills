import { stripVTControlCharacters } from "node:util";

// Rough constant, not a live exchange-rate feed.
export const USD_TO_RMB = 6.7;
const AMOUNT = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const SGR = String.raw`(?:\x1b\[[\d;]*m)*`;
const DOLLARS = new RegExp(String.raw`(-?)\$(${AMOUNT})`, "gi");

export function formatRmb(usd: number): string {
	const rmb = usd * USD_TO_RMB;
	const magnitude = Math.abs(rmb);
	return `${rmb < 0 ? "-" : ""}¥${magnitude === 0 || magnitude >= 0.01 ? magnitude.toFixed(2) : magnitude.toPrecision(2)}`;
}

/** Replace one generated dollar amount using its raw USD value, not rounded display text. */
function replacePrice(text: string, usd: number): string {
	return text.replace(new RegExp(String.raw`-?\$${AMOUNT}`, "i"), formatRmb(usd));
}

export interface SessionCosts {
	total: number;
	models: Map<string, number>;
	missed: number;
	decision?: { economicsAvailable: boolean; expectedSavings: number; missCost: number; warmCost: number };
}

/** Convert generated fields, leaving session names, paths and model identifiers alone. */
export function convertSessionInfo(text: string, costs: SessionCosts): string {
	let section = "";
	return text.split("\n").map((line) => {
		const plain = stripVTControlCharacters(line);
		if (plain === "Cache Warming" || plain === "Cost") section = plain;
		if (section === "Cache Warming" && costs.decision?.economicsAvailable) {
			if (plain.startsWith("Cache miss penalty: ")) return replacePrice(line, costs.decision.missCost);
			if (plain.startsWith("Refresh cost: ")) return replacePrice(line, costs.decision.warmCost);
			// Inactive reasons are arbitrary text. Require the actual generated economics shape.
			const economics = new RegExp(String.raw`expected savings (-?\$${AMOUNT}) (>=|<) (\$${AMOUNT})(?= -> (warm|stop)\)|\))`, "i");
			if (plain.startsWith("Status: ")) {
				return line.replace(economics, (_match, _savings: string, comparison: string, threshold: string) =>
					`expected savings ${formatRmb(costs.decision!.expectedSavings)} ${comparison} ${threshold.replace(DOLLARS, (_m, sign: string, amount: string) => formatRmb(Number(sign + amount)))}`);
			}
		}
		if (section === "Cost") {
			const colon = line.lastIndexOf(":");
			if (colon === -1) return line;
			const label = stripVTControlCharacters(line.slice(0, colon)).trim();
			const usd = label === "Total" ? costs.total : label === "Cache Re-billed" ? costs.missed : costs.models.get(label);
			if (usd !== undefined) return line.slice(0, colon + 1) + replacePrice(line.slice(colon + 1), usd);
		}
		return line;
	}).join("\n");
}

/** Notice bodies/notes are arbitrary text; the generated charge is always the final suffix. */
export function convertNotice(text: string, usd: number): string {
	const suffix = new RegExp(String.raw`(\(~|: )\$${AMOUNT}(\)?${SGR})$`, "i");
	return text.replace(suffix, (_match, prefix: string, tail: string) => `${prefix}${formatRmb(usd)}${tail}`);
}

/** The footer was laid out using RMB digits already; change only its generated currency glyph. */
export function convertFooter(line: string): string {
	if (!/^(?:[↑↓RW]\S+ |CH\S+ )*\$/.test(stripVTControlCharacters(line))) return line;
	return line.replace("$", "¥");
}
