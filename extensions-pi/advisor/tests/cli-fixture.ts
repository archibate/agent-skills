// Offline-only CLI fixture: this provider never performs I/O or delegates to a real API.
import { createAssistantMessageEventStream, createProvider, envApiKeyAuth, getCurrentTools, type Context, type Model, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const models = ["cheap", "frontier", "reviewer", "other"].map((id): Model<"openai-completions"> => ({ type: "chat", id, name: id, provider: "advisor-test", api: "openai-completions", baseUrl: "https://invalid.test", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192, cost }));
	let requests = 0;
	function reply(model: Model<Api>, context: Context) {
		if (++requests > 3) throw new Error("Offline fixture request budget exceeded");
		const stream = createAssistantMessageEventStream();
		const tools = getCurrentTools(context.messages).map((tool) => tool.name);
		const review = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "advisor");
		const reviewing = model.id === "reviewer" || model.id === "other";
		const consult = !reviewing && tools.includes("advisor") && !review;
		const message: AssistantMessage = {
			role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
			content: consult ? [{ type: "toolCall", id: "consult", name: "advisor", arguments: {} }]
				: [{ type: "text", text: reviewing ? `REVIEWER:${model.id}` : JSON.stringify({ main: model.id, tools, review: review?.content }) }],
			stopReason: consult ? "toolUse" : "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
		};
		stream.push({ type: "done", reason: consult ? "toolUse" : "stop", message }); stream.end(); return stream;
	}
	pi.registerProvider(createProvider({ id: "advisor-test", name: "Offline fixture", models, auth: { apiKey: envApiKeyAuth("Fixture", ["ADVISOR_TEST_KEY"]) }, api: { "openai-completions": { stream: reply, streamSimple: reply } } }));
}
