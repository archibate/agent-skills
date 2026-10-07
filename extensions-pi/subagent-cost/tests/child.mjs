// Offline child process: real Pi session persistence, synthetic recorded usage, no provider calls.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
const manager = SessionManager.open(process.argv[2]);
const handlers = new Map();
extension({ on: (name, fn) => handlers.set(name, fn), appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
const ctx = { sessionManager: manager, hasUI: false, mode: "print" };
handlers.get("session_start")({}, ctx);
manager.appendUsage("offline-fixture", "test", "test", {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
});
handlers.get("session_shutdown")({}, ctx);
