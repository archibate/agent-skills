import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type ProviderStreams,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/** Pi's Gemini capability parser requires a short ID, but the catalog/session identity must remain stable. */
export function googleIdentityApi(delegate: ProviderStreams): ProviderStreams {
	function wrap(
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		run: ProviderStreams["stream"],
	) {
		const nativeModel = { ...model, id: model.id.replace(/^google\//u, "") };
		// Preserve native toolCall and toolResult structures.
		// Older versions eagerly downgraded toolCalls to plain text if message.model !== model.id,
		// which polluted the assistant context and caused models to mimic raw "Tool call" text.
		// Pi's built-in convertMessages already safely handles Thought Signatures across models.
		const nativeContext: TranscriptContext = {
			...context,
			messages: context.messages.map((message) => {
				if (message.role === "assistant") {
					return { ...message, model: nativeModel.id };
				}
				return message;
			}),
		};
		// The short ID is only for Pi's capability parser; ofox routes Gemini by the full catalog ID
		// and hangs on the short one, so restore it in the outgoing request.
		// Also normalize thinkingConfig for Gemini 4/argon models on Pi SDK versions that lack major-version regex.
		const restoreRequestModel = async (payload: unknown) => {
			const next = (await options?.onPayload?.(payload, model)) ?? payload;
			const params = next as {
				model?: unknown;
				config?: { thinkingConfig?: { thinkingBudget?: unknown; thinkingLevel?: unknown } };
			};
			if (!params) return next;
			if (params.model === nativeModel.id) {
				params.model = model.id;
			}
			const isArgonOrGemini4 = /argon|gemini-(?:[4-9]|[1-9]\d)/i.test(String(model.id));
			if (isArgonOrGemini4 && params.config?.thinkingConfig) {
				const tc = params.config.thinkingConfig;
				if (tc.thinkingBudget !== undefined) {
					delete tc.thinkingBudget;
					if (tc.thinkingLevel === undefined) {
						tc.thinkingLevel = "high";
					}
				}
			}
			return params;
		};
		const nativeOptions = {
			...options,
			onPayload: restoreRequestModel,
			onProviderStreamEvent: options?.onProviderStreamEvent &&
				((data: unknown) => options.onProviderStreamEvent!(data, model)),
		};
		const stream = createAssistantMessageEventStream();
		const restored = new WeakMap<AssistantMessage, AssistantMessage>();
		const restore = (message: AssistantMessage): AssistantMessage => {
			let publicMessage = restored.get(message);
			if (!publicMessage) {
				publicMessage = { ...message, model: model.id };
				restored.set(message, publicMessage);
			} else {
				Object.assign(publicMessage, message, { model: model.id });
			}
			return publicMessage;
		};
		void (async () => {
			try {
				for await (const event of run(nativeModel, nativeContext, nativeOptions)) {
					if (event.type === "done") stream.push({ ...event, message: restore(event.message) });
					else if (event.type === "error") stream.push({ ...event, error: restore(event.error) });
					else stream.push({ ...event, partial: restore(event.partial) });
				}
			} catch {
				stream.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], timestamp: Date.now(), stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: "Ofox Gemini stream failed",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
			} finally {
				stream.end();
			}
		})();
		return stream;
	}
	return {
		stream: (model, context, options) => wrap(model, context, options, delegate.stream.bind(delegate)),
		streamSimple: (model, context, options) => wrap(model, context, options, delegate.streamSimple.bind(delegate)),
	};
}
