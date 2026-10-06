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
		const foreignCalls = new Set<string>();
		const nativeContext: TranscriptContext = {
			...context,
			messages: context.messages.map((message) => {
				if (message.role === "assistant") {
					const sameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
					if (sameModel) {
						for (const block of message.content) if (block.type === "toolCall") foreignCalls.delete(block.id);
						return { ...message, model: nativeModel.id };
					}
					if (!message.content.some((block) => block.type === "toolCall")) return message;
					// Foreign signatures are not valid for this model. Preserve tool
					// history as text, rather than emitting unsigned Gemini calls.
					return { ...message, content: message.content.map((block) => {
						if (block.type !== "toolCall") return block;
						foreignCalls.add(block.id);
						return { type: "text" as const, text: `Tool call ${block.name}: ${JSON.stringify(block.arguments)}` };
					}) };
				}
				if (message.role === "toolResult" && foreignCalls.delete(message.toolCallId)) {
					return { role: "user" as const, timestamp: message.timestamp, content: [
						{ type: "text" as const, text: `Tool ${message.isError ? "error" : "result"} ${message.toolName}:` },
						...message.content,
					] };
				}
				return message;
			}),
		};
		const nativeOptions = options && {
			...options,
			onPayload: options.onPayload && ((payload: unknown) => options.onPayload!(payload, model)),
			onProviderStreamEvent: options.onProviderStreamEvent &&
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
