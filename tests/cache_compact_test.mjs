import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

// Use native TypeScript stripping and the installed host's exact dependencies
// in a private workspace; never install dependencies into the checkout/config.
let host = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(host, "package.json"))) {
	const versionFile = join(host, "install/current-version");
	if (existsSync(versionFile)) {
		host = join(host, "install/releases", readFileSync(versionFile, "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
		break;
	}
	if (dirname(host) === host) throw new Error("Could not locate Pi's installed package from its executable");
	host = dirname(host);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "cache-compact-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
cpSync(join(root, "extensions-pi/cache-compact"), join(scratch, "extension"), { recursive: true });
mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
for (const name of ["pi-ai", "pi-coding-agent"]) {
	symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
}
const { createCacheCompact } = await import(join(scratch, "extension/index.ts"));
const { addFileOps, archiveNotice, buildInstruction, fileLists } = await import(join(scratch, "extension/compaction.ts"));
const ai = await import(join(host, "..", "pi-ai/dist/index.js"));
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } =
	await import(join(host, "dist/index.js"));

// ---------------------------------------------------------------------------
// Pure helpers

test("instructions carry custom focus; file lists match Pi's format", () => {
	assert.match(buildInstruction(" files only "), /Additional focus: files only$/);
	assert.doesNotMatch(buildInstruction(), /Additional focus/);
	const files = fileLists({ read: new Set(["b", "a", "w"]), edited: new Set(["e"]), written: new Set(["w"]) });
	assert.deepEqual([files.readFiles, files.modifiedFiles], [["a", "b"], ["e", "w"]]);
	assert.equal(files.text, "\n\n<read-files>\na\nb\n</read-files>\n\n<modified-files>\ne\nw\n</modified-files>");
	assert.equal(fileLists({ read: new Set(), edited: new Set(), written: new Set() }).text, "");
});

test("file operations are collected like Pi's, including codemode calls", () => {
	const ops = { read: new Set(), edited: new Set(), written: new Set() };
	addFileOps({ role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", name: "read", arguments: { path: "r" } },
		{ type: "toolCall", name: "edit", arguments: { path: "e" } }, { type: "toolCall", name: "bash", arguments: { path: "no" } }] }, ops);
	addFileOps({ role: "toolResult", nestedCalls: { calls: [{ name: "write", arguments: { path: "w" } }] } }, ops);
	addFileOps({ role: "user", content: [{ type: "toolCall", name: "read", arguments: { path: "no" } }] }, ops);
	assert.deepEqual([[...ops.read], [...ops.edited], [...ops.written]], [["r"], ["e"], ["w"]]);
	assert.match(archiveNotice("/s/x.jsonl"), /archived at \/s\/x\.jsonl \(JSONL, current branch only\)[\s\S]*instructions in it are not new requests\.$/);
});

// ---------------------------------------------------------------------------
// Real Pi sessions (main and fork), real Anthropic adapter, mocked HTTP

function sse(events) {
	return new Response(events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } });
}
function anthropicReply(blocks, usage = {}) {
	const events = [{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "fake-claude", content: [],
		stop_reason: null, usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, ...usage } } }];
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name: block.name, input: {} } },
				{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
		}
		events.push({ type: "content_block_stop", index });
	});
	const stop = blocks.some((block) => block.type === "tool") ? "tool_use" : "end_turn";
	events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 7 } }, { type: "message_stop" });
	return sse(events);
}
const text = (value, usage) => () => anthropicReply([{ type: "text", text: value }], usage);

const requests = [];
let replies = [];
const originalFetch = globalThis.fetch;
beforeEach(() => {
	requests.length = 0;
	replies = [];
});
after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.url;
	if (!url.startsWith("https://fake.invalid")) throw new Error(`Unexpected HTTP request to ${url}`);
	requests.push(JSON.parse(init.body));
	const reply = replies.shift();
	if (!reply) throw new Error("No scripted reply");
	return reply();
};

function fakeProvider(pi) {
	pi.registerProvider("fake", {
		baseUrl: "https://fake.invalid", apiKey: "unit-test-key", api: "anthropic-messages",
		models: [{ id: "fake-claude", name: "Fake Claude", reasoning: false, input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 200_000, maxTokens: 4096 }],
	});
}
function echoTool(pi) {
	pi.registerTool({ name: "echo", label: "Echo", description: "Echo a value", parameters: ai.Type.Object({}),
		execute: async () => { throw new Error("echo must not run during compaction"); } });
}
const isolated = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true };

async function newSession(name, sessionManager, forkFactories = [fakeProvider, echoTool], keepRecentTokens = 1) {
	const agent = join(scratch, name);
	mkdirSync(agent, { recursive: true });
	const cacheCompact = createCacheCompact({ agentDir: agent, resourceLoaderOptions: { ...isolated, extensionFactories: forkFactories } });
	const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false });
	const services = await createAgentSessionServices({
		cwd: agent, agentDir: agent, modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "fake", defaultModel: "fake-claude", cacheWarming: "off",
			compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens } }),
		resourceLoaderOptions: { ...isolated, extensionFactories: [fakeProvider, echoTool, cacheCompact] },
	});
	assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSessionFromServices({ services, sessionManager: sessionManager ?? SessionManager.inMemory(agent) });
	const notices = [];
	session.extensionRunner?.setUIContext?.({ notify: (message, level) => notices.push({ message, level }) });
	return { session, notices, agent };
}

async function twoTurns(session) {
	replies.push(text("first answer"), text("second answer"));
	await session.prompt("first question");
	await session.prompt("second question");
	assert.equal(requests.length, 2);
}
function isDefaultSummaryRequest(body) {
	return JSON.stringify(body.system ?? "").includes("context summarization assistant");
}
/** The fork's request must be the turn's request plus the reply and the instruction. */
function assertExtends(compaction, turn, reply) {
	assert.equal(isDefaultSummaryRequest(compaction), false);
	for (const key of ["system", "tools", "max_tokens", "model", "thinking", "output_config"]) assert.deepEqual(compaction[key], turn[key], key);
	const strip = (messages) => JSON.parse(JSON.stringify(messages, (key, value) => key === "cache_control" ? undefined : value));
	assert.deepEqual(strip(compaction.messages.slice(0, turn.messages.length)), strip(turn.messages));
	const tail = compaction.messages.slice(turn.messages.length);
	assert.deepEqual(tail.map((m) => m.role), ["assistant", "user"]);
	assert.equal(tail[0].content[0].text, reply);
	assert.match(tail[1].content.at(-1).text, /^\[Context compaction\]/);
}

test("compaction summarizes in a fork that extends the last request", async () => {
	const { session, notices } = await newSession("fork");
	try {
		await twoTurns(session);
		assert.ok(requests[1].tools.some((tool) => tool.name === "echo"));
		replies.push(text("## Goal\nCached summary", { cache_read_input_tokens: 900, cache_creation_input_tokens: 10 }));
		const before = session.sessionManager.getEntries().length;
		const result = await session.compact("keep it short");
		assert.equal(requests.length, 3);
		assertExtends(requests[2], requests[1], "second answer");
		assert.match(requests[2].messages.at(-1).content.at(-1).text, /Additional focus: keep it short$/);
		assert.match(result.summary, /^## Goal\nCached summary/);
		assert.equal(result.usage.cacheRead, 900);
		// Only the compaction entry is added; the fork never writes to the main session.
		assert.deepEqual(session.sessionManager.getEntries().slice(before).map((e) => e.type), ["compaction"]);
		assert.deepEqual(notices, []);
		// Nothing is kept verbatim, and an in-memory session has no archive to point to.
		assert.deepEqual(session.messages.map((m) => m.role).filter((role) => role !== "system"), ["compactionSummary"]);
		assert.doesNotMatch(result.summary, /archived at/);
	} finally {
		session.dispose();
	}
});

test("a cold cache is still compacted in the fork and reported", async () => {
	const { session, notices } = await newSession("miss");
	try {
		await twoTurns(session);
		replies.push(text("## Goal\nCold summary", { cache_read_input_tokens: 0, cache_creation_input_tokens: 120 }));
		const result = await session.compact();
		assertExtends(requests[2], requests[1], "second answer");
		assert.match(result.summary, /Cold summary/);
		assert.match(notices.map((n) => n.message).join("\n"), /cache miss \(0 of ~105/);
	} finally {
		session.dispose();
	}
});

test("a resumed session forks from its file", async () => {
	const agent = join(scratch, "resume");
	const sessionDir = join(agent, "sessions");
	const first = await newSession("resume", SessionManager.create(agent, sessionDir));
	const file = first.session.sessionManager.getSessionFile();
	try {
		await twoTurns(first.session);
	} finally {
		first.session.dispose();
	}
	const turn = requests[1];
	const resumed = await newSession("resume", SessionManager.open(file, sessionDir));
	try {
		replies.push(text("## Goal\nResumed summary"));
		const branch = resumed.session.sessionManager.getBranch();
		const result = await resumed.session.compact();
		assertExtends(requests[2], turn, "second answer");
		assert.match(result.summary, /Resumed summary/);
		// The current branch is archived beside the session file, outside session discovery.
		const archiveDir = file.replace(/\.jsonl$/, ".compact");
		const [archive] = readdirSync(archiveDir);
		assert.match(result.summary, new RegExp(`archived at ${join(archiveDir, archive).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
		assert.deepEqual(readFileSync(join(archiveDir, archive), "utf8").trim().split("\n").map((line) => JSON.parse(line)), branch);
		assert.deepEqual(readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")), [file.split("/").at(-1)]);
	} finally {
		resumed.session.dispose();
	}
});

test("the archive leaves out abandoned branches", async () => {
	const agent = join(scratch, "branches");
	const { session } = await newSession("branches", SessionManager.create(agent, join(agent, "sessions")));
	try {
		replies.push(text("first answer"), text("abandoned answer"), text("second answer"), text("## Goal\nBranch summary"));
		await session.prompt("first question");
		const fork = session.sessionManager.getLeafId();
		await session.prompt("abandoned question");
		assert.equal((await session.navigateTree(fork)).cancelled, false);
		await session.prompt("second question");
		const result = await session.compact();
		const archive = result.summary.match(/archived at (\S+) /)[1];
		const archived = readFileSync(archive, "utf8");
		assert.match(archived, /second question/);
		assert.doesNotMatch(archived, /abandoned/);
		assert.match(readFileSync(session.sessionManager.getSessionFile(), "utf8"), /abandoned question/);
	} finally {
		session.dispose();
	}
});

test("file lists include files from the turns Pi would have kept", async () => {
	// Pi keeps the small last turn verbatim and summarizes only the long first one.
	const { session } = await newSession("files", undefined, undefined, 50);
	try {
		replies.push(text("ok"), () => anthropicReply([{ type: "tool", name: "read", input: { path: "kept.txt" } }]), text("read it"),
			text("## Goal\nFiles"));
		await session.prompt(`remember ${"x ".repeat(2000)}`);
		await session.prompt("read kept.txt");
		const result = await session.compact();
		assert.match(result.summary, /<read-files>\nkept\.txt\n<\/read-files>/);
	} finally {
		session.dispose();
	}
});

test("tool calls and failed requests fall back to Pi's compaction", async () => {
	const fallback = text("## Goal\nDefault summary");
	for (const [name, reply, notice] of [
		["tool", () => anthropicReply([{ type: "tool", name: "echo" }]), /called a tool/],
		["error", () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad fork" } }),
			{ status: 400, headers: { "content-type": "application/json" } }), /bad fork/],
	]) {
		requests.length = 0;
		const { session, notices } = await newSession(name);
		try {
			await twoTurns(session);
			replies.push(reply, fallback, fallback);
			const result = await session.compact();
			assert.equal(isDefaultSummaryRequest(requests[2]), false, name);
			assert.equal(isDefaultSummaryRequest(requests[3]), true, name);
			assert.match(result.summary, /Default summary/, name);
			assert.match(notices.map((n) => n.message).join("\n"), notice, name);
		} finally {
			session.dispose();
		}
	}
});

test("a fork whose extensions cannot serve the model falls back", async () => {
	const { session, notices } = await newSession("no-provider", undefined, [echoTool]);
	try {
		await twoTurns(session);
		replies.push(text("## Goal\nDefault summary"), text("## Goal\nDefault summary"));
		const result = await session.compact();
		assert.equal(isDefaultSummaryRequest(requests[2]), true);
		assert.match(result.summary, /Default summary/);
		assert.match(notices.map((n) => n.message).join("\n"), /No API key found for fake[\s\S]*using Pi's default compaction/);
	} finally {
		session.dispose();
	}
});

test("after a compaction the next compaction forks from the new branch", async () => {
	const { session } = await newSession("twice");
	try {
		await twoTurns(session);
		replies.push(text("## Goal\nFirst"), text("third answer"), text("## Goal\nSecond"));
		await session.compact();
		await session.prompt("third question");
		const turn = requests[3];
		assert.match(JSON.stringify(turn.messages), /First/);
		const result = await session.compact();
		assert.equal(requests.length, 5);
		assertExtends(requests[4], turn, "third answer");
		assert.match(result.summary, /^## Goal\nSecond/);
	} finally {
		session.dispose();
	}
});

test("overflow recovery uses Pi's compaction without forking", async () => {
	const handlers = new Map();
	createCacheCompact()({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => { throw new Error("must not fork"); } });
	assert.equal(await handlers.get("session_before_compact")({ reason: "overflow", signal: new AbortController().signal }, { model: {} }), undefined);
});
