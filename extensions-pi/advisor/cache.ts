import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface Endpoint { identity: string; count: number; digest: string }

/** Only fingerprints are retained. Cache hits are reported by the provider, not inferred here. */
export class TranscriptCache {
	private previous: Endpoint | undefined;
	reset(): void { this.previous = undefined; }

	/** Apply markers to the actual Anthropic wire blocks, after Pi's conversion. */
	prepare(payload: unknown, identity: string, retention: "none" | "short" | "long"): () => void {
		if (!object(payload) || !Array.isArray(payload.messages) || payload.messages.length !== 1 ||
			!object(payload.messages[0]) || payload.messages[0].role !== "user" || !Array.isArray(payload.messages[0].content)) {
			throw new Error("Advisor expected one multimodal user message; refusing an incompatible Anthropic payload.");
		}
		const blocks = payload.messages[0].content;
		if (!blocks.length || blocks.some((b) => !object(b) || (b.type !== "text" && b.type !== "image"))) {
			throw new Error("Advisor received unsupported Anthropic transcript blocks.");
		}
		for (const block of blocks) delete block.cache_control;
		// Own all cache markers (at most three): reviewer system, old endpoint, new endpoint.
		delete payload.cache_control;
		if (Array.isArray(payload.system)) for (const block of payload.system) if (object(block)) delete block.cache_control;
		if (retention === "none") return () => this.reset();
		const marker = { type: "ephemeral", ...(retention === "long" ? { ttl: "1h" } : {}) };
		const hash = createHash("sha256");
		// Settings and the leading system prompt also belong to the cached prefix.
		hash.update(JSON.stringify({ ...payload, messages: undefined }));
		let oldMatches = false;
		for (let i = 0; i < blocks.length; i++) {
			hash.update(JSON.stringify(blocks[i]));
			if (this.previous?.identity === identity && i + 1 === this.previous.count) {
				oldMatches = hash.copy().digest("hex") === this.previous.digest;
			}
		}
		const next: Endpoint = { identity, count: blocks.length, digest: hash.digest("hex") };
		if (oldMatches) blocks[this.previous!.count - 1].cache_control = { ...marker };
		blocks.at(-1)!.cache_control = { ...marker };
		if (Array.isArray(payload.system) && object(payload.system.at(-1))) payload.system.at(-1).cache_control = { ...marker };
		return () => { this.previous = next; };
	}
}
