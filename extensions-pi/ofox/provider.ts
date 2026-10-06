import {
	createProvider,
	envApiKeyAuth,
	hasApi,
	type Api,
	type Model,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi, googleGenerativeAIApi, openAICompletionsApi, openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { googleIdentityApi } from "./google-identity.ts";

export const PROVIDER_ID = "ofox";
export const CATALOG_TTL_MS = 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
const ORIGIN = "https://api.ofox.io";
const URLS = {
	"anthropic-messages": `${ORIGIN}/anthropic`,
	"google-generative-ai": `${ORIGIN}/gemini/v1beta`,
	"openai-responses": `${ORIGIN}/v1`,
	"openai-completions": `${ORIGIN}/v1`,
} as const;
type OfoxApi = keyof typeof URLS;
type OfoxModel = Model<OfoxApi>;
type Row = Record<string, unknown>;
export interface Catalogs {
	main: unknown;
	anthropic: unknown;
	google: unknown;
}

function object(value: unknown): Row {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function price(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (typeof value === "string" && !value.trim()) return undefined;
	const perMillion = Number(value) * 1_000_000;
	return Number.isFinite(perMillion) && perMillion >= 0 ? perMillion : undefined;
}
function rows(payload: unknown, field: "data" | "models"): Row[] {
	const value = object(payload)[field];
	if (!Array.isArray(value) || value.length > MAX_MODELS) throw new Error("Ofox returned an invalid model catalog");
	// Do not silently install a partial catalog if the service introduces pagination.
	if (object(payload).has_more === true || object(payload).nextPageToken) {
		throw new Error("Ofox model catalog pagination is not supported");
	}
	return value.map(object);
}

const vendorProviders: Record<string, BuiltinProvider> = {
	anthropic: "anthropic", google: "google", openai: "openai", "x-ai": "xai", deepseek: "deepseek",
};
const metadata = new Map<string, readonly Model<Api>[]>();
function knownModel(row: Row): Model<Api> | undefined {
	const id = String(row.id);
	const vendor = id.split("/")[0];
	const provider = vendorProviders[vendor];
	if (!provider) return undefined;
	let models = metadata.get(vendor);
	if (!models) {
		models = getBuiltinModels(provider);
		metadata.set(vendor, models);
	}
	const shortId = id.split("/").slice(1).join("/");
	const aliases = new Set([shortId, row.canonical_slug, ...strings(row.aliases)]);
	if (vendor === "anthropic") aliases.add(shortId.replaceAll(".", "-"));
	return models.find((model) => aliases.has(model.id));
}

/** The live catalog controls inventory, limits, and prices. Pi only supplements known model capabilities. */
export function normalizeCatalogs(catalogs: Catalogs): OfoxModel[] {
	const anthropic = new Set(rows(catalogs.anthropic, "data").map((row) => row.id));
	const google = new Set(rows(catalogs.google, "models")
		.filter((row) => strings(row.supportedGenerationMethods).includes("generateContent"))
		.map((row) => typeof row.name === "string" ? row.name.replace(/^models\//u, "") : ""));
	const seen = new Set<string>();
	const models: OfoxModel[] = [];
	for (const row of rows(catalogs.main, "data")) {
		const id = row.id;
		if (typeof id !== "string" || !/^[\w./-]+$/u.test(id) || row.is_deprecated === true || seen.has(id)) continue;
		const architecture = object(row.architecture);
		if (!strings(architecture.input_modalities).includes("text") ||
			!strings(architecture.output_modalities).includes("text") ||
			strings(architecture.output_modalities).some((value) => value !== "text")) continue;
		const endpoints = strings(row.supported_endpoints);
		let api: OfoxApi;
		if (id.startsWith("anthropic/") && anthropic.has(id)) api = "anthropic-messages";
		else if (id.startsWith("google/") && google.has(id)) api = "google-generative-ai";
		else if (endpoints.includes("/v1/responses")) api = "openai-responses";
		else if (endpoints.includes("/v1/chat/completions")) api = "openai-completions";
		else continue;
		const top = object(row.top_provider);
		const contextWindow = positive(top.context_length) ?? positive(row.context_length);
		const maxTokens = positive(top.max_completion_tokens);
		const pricing = object(row.pricing);
		const input = price(pricing.prompt);
		const output = price(pricing.completion);
		if (!contextWindow || !maxTokens || input === undefined || output === undefined) continue;
		const known = knownModel(row);
		const reasoning = strings(row.supported_parameters).includes("reasoning") || known?.reasoning === true;
		const model: OfoxModel = {
			type: "chat", provider: PROVIDER_ID, id,
			name: typeof row.name === "string" && row.name ? row.name : id,
			api, baseUrl: URLS[api], reasoning,
			input: strings(architecture.input_modalities).includes("image") ? ["text", "image"] : ["text"],
			contextWindow, maxTokens: Math.min(maxTokens, contextWindow),
			cost: {
				input, output,
				cacheRead: price(pricing.input_cache_read) ?? 0,
				cacheWrite: price(pricing.input_cache_write_5m ?? pricing.input_cache_write) ?? 0,
			},
		};
		if (reasoning && known?.thinkingLevelMap) model.thinkingLevelMap = known.thinkingLevelMap;
		if (known?.inputLimits) model.inputLimits = known.inputLimits;
		if (api === "anthropic-messages") {
			// Do not inherit direct-Anthropic transcript extensions through the gateway.
			const native = known && hasApi(known, "anthropic-messages") ? known : undefined;
			model.compat = {
				forceAdaptiveThinking: native?.compat?.forceAdaptiveThinking,
				supportsTemperature: native?.compat?.supportsTemperature,
				supportsMidConvoEffort: false,
				supportsMidConvoSystemMessages: false,
				supportsMidConvoToolChanges: false,
			};
		}
		// No speculative gateway compatibility flags or idle cache-warming lifetimes.
		seen.add(id);
		models.push(model);
	}
	if (!models.length) throw new Error("Ofox returned no usable chat models");
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchJson(path: string, key: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(`${ORIGIN}${path}`, {
			headers: {
				Authorization: `Bearer ${key}`, "x-api-key": key, "x-goog-api-key": key,
				"anthropic-version": "2023-06-01",
			},
			redirect: "error", signal,
		});
	} catch {
		throw new Error(signal.aborted ? "Ofox catalog request cancelled or timed out" : "Ofox catalog request failed");
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Ofox model catalog returned HTTP ${response.status}`);
	}
	if (!response.body) throw new Error("Ofox model catalog response was empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_CATALOG_BYTES) throw new Error("Ofox model catalog exceeded the size limit");
			chunks.push(value);
		}
	} catch {
		await reader.cancel().catch(() => {});
		throw new Error(signal.aborted ? "Ofox catalog request cancelled or timed out" : "Ofox model catalog could not be read within the size limit");
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("Ofox returned invalid model catalog JSON");
	}
}

export async function discoverModels(key: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<OfoxModel[]> {
	const controller = new AbortController();
	const bounded = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	try {
		const [main, anthropic, google] = await Promise.all([
			fetchJson("/v1/models", key, bounded, fetcher),
			fetchJson("/anthropic/v1/models", key, bounded, fetcher),
			fetchJson("/gemini/v1beta/models", key, bounded, fetcher),
		]);
		return normalizeCatalogs({ main, anthropic, google });
	} finally {
		controller.abort(); // Cancel sibling requests after either success or failure.
	}
}

function validCachedModel(value: unknown): value is OfoxModel {
	const row = object(value);
	return row.provider === PROVIDER_ID && row.type === "chat" && typeof row.id === "string" &&
		typeof row.api === "string" && Object.hasOwn(URLS, row.api) && row.baseUrl === URLS[row.api as OfoxApi] &&
		Boolean(positive(row.contextWindow) && positive(row.maxTokens)) && typeof row.reasoning === "boolean" &&
		strings(row.input).includes("text") && typeof row.name === "string" &&
		["input", "output", "cacheRead", "cacheWrite"].every((field) => {
			const value = object(row.cost)[field];
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		});
}

export function createOfoxProvider(options: {
	discover?: typeof discoverModels;
	now?: () => number;
} = {}): Provider<OfoxApi> {
	const discover = options.discover ?? discoverModels;
	const now = options.now ?? Date.now;
	let models: readonly OfoxModel[] = [];
	let checkedAt = 0;
	const streams = createProvider<OfoxApi>({
		id: PROVIDER_ID, name: "Ofox", auth: { apiKey: envApiKeyAuth("Ofox API key", ["OFOX_API_KEY"]) },
		models: [],
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleIdentityApi(googleGenerativeAIApi()),
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
	return {
		...streams,
		getModels: () => models,
		getAllModels: () => models,
		refreshModels: async (context: RefreshModelsContext) => {
			const stored = context.stored;
			if (stored && (stored.checkedAt ?? 0) >= checkedAt) {
				const restored = stored.models.filter(validCachedModel);
				if (restored.length && restored.length <= MAX_MODELS) {
					if (!await context.publish({ update: () => {
						models = restored;
						checkedAt = stored.checkedAt ?? 0;
					} })) return;
				}
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const age = now() - checkedAt;
			if (!context.force && models.length && age >= 0 && age < CATALOG_TTL_MS) return;
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!key) return;
			const refreshed = await discover(key, context.signal);
			context.signal.throwIfAborted();
			const timestamp = now();
			await context.publish({
				persist: { models: refreshed, checkedAt: timestamp },
				update: () => { models = refreshed; checkedAt = timestamp; },
			});
		},
	};
}
