import assert from "node:assert/strict";
import { test } from "node:test";
import { FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import rmb from "../../rmb-cost/index.ts";
import costs from "../index.ts";

test("warm upgrade adopts an existing RMB wrapper in either extension load order", async () => {
	const api = { on() {}, registerToolRenderer() {} };
	await rmb(api);
	const methods = ["handleSessionCommand", "addCacheWarmingUsage", "addCompactionCostNotice", "addCacheMissNotice"];
	const wrappers = methods.map((name) => InteractiveMode.prototype[name]);
	// The previous rmb-cost version marked functions but had no prototype dispatch slots.
	for (const name of methods) Reflect.deleteProperty(InteractiveMode.prototype, Symbol.for(`pi.rmb-cost.notice.${name}`));
	// First reload after upgrading rmb-cost and installing subagent-cost.
	if (process.env.COST_LOAD_ORDER === "rmb-first") { await rmb(api); costs(api); }
	else { costs(api); await rmb(api); }
	for (let i = 0; i < methods.length; i++) {
		assert.equal(Reflect.get(InteractiveMode.prototype, Symbol.for(`pi.rmb-cost.notice.${methods[i]}`)), wrappers[i]);
	}
	const before = [InteractiveMode.prototype.handleSessionCommand, FooterComponent.prototype.getSessionStats];
	for (let i = 0; i < 3; i++) { await rmb(api); costs(api); }
	assert.deepEqual([InteractiveMode.prototype.handleSessionCommand, FooterComponent.prototype.getSessionStats], before);
});
