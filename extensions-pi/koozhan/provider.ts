import {
	createProvider,
	envApiKeyAuth,
	hasApi,
	type Api,
	type Model,
	type Provider,
	type ProviderStreams,
	type RefreshModelsContext,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "koozhan";
export const CATALOG_TTL_MS = 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 2000;
const ORIGIN = "https://api.koozhan.com";
const CATALOG_PATH = "/v1/relay/models";
const URLS = {
	"anthropic-messages": ORIGIN,
	"openai-responses": `${ORIGIN}/v1`,
} as const;
type KoozhanApi = keyof typeof URLS;
type KoozhanModel = Model<KoozhanApi>;
type Row = Record<string, unknown>;

function object(value: unknown): Row {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** Koozhan already quotes USD per million tokens, the unit Pi uses. */
function price(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Only Claude and GPT families are routed. Everything else, including DeepSeek and
 * its time-of-use prices, is deliberately excluded.
 */
function family(id: string): { api: KoozhanApi; builtin: BuiltinProvider } | undefined {
	if (id.startsWith("claude-")) return { api: "anthropic-messages", builtin: "anthropic" };
	if (id.startsWith("gpt-")) return { api: "openai-responses", builtin: "openai" };
	return undefined;
}
const metadata = new Map<BuiltinProvider, readonly Model<Api>[]>();
function knownModel(provider: BuiltinProvider, id: string): Model<Api> | undefined {
	let models = metadata.get(provider);
	if (!models) {
		models = getBuiltinModels(provider);
		metadata.set(provider, models);
	}
	return models.find((model) => model.id === id);
}

/**
 * The live catalog controls inventory, availability, context limit and prices.
 * Pi's built-in models supply capabilities the catalog does not publish, so models
 * unknown to this Pi version are skipped instead of guessed.
 */
export function normalizeCatalog(payload: unknown): KoozhanModel[] {
	const rows = object(payload).models;
	if (!Array.isArray(rows) || rows.length > MAX_MODELS) throw new Error("Koozhan returned an invalid model catalog");
	const seen = new Set<string>();
	const models: KoozhanModel[] = [];
	for (const row of rows.map(object)) {
		const id = row.id;
		if (typeof id !== "string" || !/^[\w.-]+$/u.test(id) || seen.has(id)) continue;
		if (row.chat_selectable !== true || row.status !== "available") continue;
		const route = family(id);
		if (!route) continue;
		const pricing = object(row.pricing);
		if (pricing.pricing_mode === "time_of_use") continue; // A flat price would drift.
		const input = price(pricing.input_usd_per_1m_tokens);
		const output = price(pricing.output_usd_per_1m_tokens);
		const contextLimit = positive(row.max_tokens);
		const known = knownModel(route.builtin, id);
		if (input === undefined || output === undefined || !contextLimit || !known) continue;
		const contextWindow = Math.min(contextLimit, known.contextWindow);
		const model: KoozhanModel = {
			type: "chat", provider: PROVIDER_ID, id,
			name: typeof row.display_name === "string" && row.display_name ? row.display_name : id,
			api: route.api, baseUrl: URLS[route.api], reasoning: known.reasoning,
			input: [...known.input], contextWindow, maxTokens: Math.min(known.maxTokens, contextWindow),
			// No tiers: Koozhan bills one flat rate; Pi bills 1h writes at 2x input, as Koozhan does.
			cost: {
				input, output,
				cacheRead: price(pricing.cache_read_usd_per_1m_tokens) ?? 0,
				cacheWrite: price(pricing.cache_creation_5m_usd_per_1m_tokens) ?? 0,
			},
		};
		if (known.reasoning && known.thinkingLevelMap) model.thinkingLevelMap = known.thinkingLevelMap;
		if (known.inputLimits) model.inputLimits = known.inputLimits;
		if (route.api === "anthropic-messages" && hasApi(known, "anthropic-messages")) {
			// Koozhan forwards Anthropic API-key traffic unchanged, so native features apply,
			// except server-side fallback to models it may not route or price the same.
			if (known.compat) {
				const { allowedFallbackModels: _fallbacks, ...compat } = known.compat;
				model.compat = compat;
			}
			// Verified: Koozhan honors explicit 5m and 1h cache TTLs.
			if (known.promptCache) model.promptCache = known.promptCache;
		}
		// GPT keeps default Responses compatibility; native OpenAI-only flags are unverified here.
		seen.add(id);
		models.push(model);
	}
	if (!models.length) throw new Error("Koozhan returned no usable chat models");
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchCatalog(key: string, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(`${ORIGIN}${CATALOG_PATH}`, {
			headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
			redirect: "error", signal,
		});
	} catch {
		throw new Error(signal.aborted ? "Koozhan catalog request cancelled or timed out" : "Koozhan catalog request failed");
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Koozhan model catalog returned HTTP ${response.status}`);
	}
	if (!response.body) throw new Error("Koozhan model catalog response was empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_CATALOG_BYTES) throw new Error("Koozhan model catalog exceeded the size limit");
			chunks.push(value);
		}
	} catch {
		await reader.cancel().catch(() => {});
		throw new Error(signal.aborted ? "Koozhan catalog request cancelled or timed out" : "Koozhan model catalog could not be read within the size limit");
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
		throw new Error("Koozhan returned invalid model catalog JSON");
	}
}

export async function discoverModels(key: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<KoozhanModel[]> {
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	return normalizeCatalog(await fetchCatalog(key, bounded, fetcher));
}

/**
 * Koozhan adds a 1h cache breakpoint to Anthropic requests without `cache_control`
 * and rejects every way to opt out, so "no cache" bills as a 2x-input write. An
 * explicit 5m marker (1.25x) is honored, so requests asking for none get short.
 */
export function shortCacheFloor(delegate: ProviderStreams): ProviderStreams {
	const floor = <T extends StreamOptions>(options?: T): T | undefined =>
		options?.cacheRetention === "none" ? { ...options, cacheRetention: "short" } : options;
	return {
		...delegate,
		stream: (model, context, options) => delegate.stream(model, context, floor(options)),
		streamSimple: (model, context, options) => delegate.streamSimple(model, context, floor(options)),
	};
}

function validCachedModel(value: unknown): value is KoozhanModel {
	const row = object(value);
	return row.provider === PROVIDER_ID && row.type === "chat" && typeof row.id === "string" &&
		typeof row.api === "string" && Object.hasOwn(URLS, row.api) && row.baseUrl === URLS[row.api as KoozhanApi] &&
		Boolean(positive(row.contextWindow) && positive(row.maxTokens)) && typeof row.reasoning === "boolean" &&
		Array.isArray(row.input) && row.input.includes("text") && typeof row.name === "string" &&
		["input", "output", "cacheRead", "cacheWrite"].every((field) => price(object(row.cost)[field]) !== undefined);
}

export function createKoozhanProvider(options: {
	discover?: typeof discoverModels;
	now?: () => number;
} = {}): Provider<KoozhanApi> {
	const discover = options.discover ?? discoverModels;
	const now = options.now ?? Date.now;
	let models: readonly KoozhanModel[] = [];
	let checkedAt = 0;
	const streams = createProvider<KoozhanApi>({
		id: PROVIDER_ID, name: "Koozhan", auth: { apiKey: envApiKeyAuth("Koozhan API key", ["KOOZHAN_API_KEY"]) },
		models: [],
		api: {
			"anthropic-messages": shortCacheFloor(anthropicMessagesApi()),
			"openai-responses": openAIResponsesApi(),
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
