import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { fixture } from "./host.mjs";
const f = fixture();
after(f.cleanup);
const { savePairing, readPolicy } = await f.load("pairings.ts");
const { CHOICE_ENTRY, sessionChoice, restoreChoice } = await f.load("session-choice.ts");
const path = () => join(mkdtempSync(join(f.scratch, "save-")), "advisor.json");

test("save merges the latest file, supports explicit none, and leaves no temporary/lock files", () => {
	const file = path();
	savePairing(file, "main/one", "reviewer/one");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	writeFileSync(file, '{"pairings":{"main/one":"reviewer/one","main/two":"reviewer/two"}}');
	savePairing(file, "main/one", null);
	assert.deepEqual([...readPolicy(undefined, file).pairings], [["main/one", null], ["main/two", "reviewer/two"]]);
	assert.deepEqual(readdirSync(join(file, "..")), ["advisor.json"]);
});

test("malformed config, symlinks, and an existing lock are never overwritten", () => {
	const file = path();
	writeFileSync(file, "invalid");
	assert.throws(() => savePairing(file, "main/one", null), /valid JSON/);
	assert.equal(readFileSync(file, "utf8"), "invalid");
	assert.equal(existsSync(`${file}.lock`), false);
	const link = path(); symlinkSync(file, link);
	assert.throws(() => savePairing(link, "main/one", null), /symlink/);
	assert.equal(readFileSync(file, "utf8"), "invalid");
	const lock = openSync(`${file}.lock`, "wx");
	try { assert.throws(() => savePairing(file, "main/one", null), /locked/); }
	finally { closeSync(lock); unlinkSync(`${file}.lock`); }
	assert.equal(readFileSync(file, "utf8"), "invalid");
});

test("separate processes merge under the lock without losing unrelated pairings", { timeout: 10_000 }, async () => {
	const file = path();
	const module = pathToFileURL(join(f.scratch, "extension/pairings.ts")).href;
	const code = `import {savePairing} from ${JSON.stringify(module)};
		for(let i=0;i<8;i++) { let done=false; for(let retry=0;retry<100;retry++) {
			try { savePairing(process.argv[1], process.argv[2]+'/'+i, 'reviewer/model'); done=true; break; }
			catch(e) { if(!e.message.includes('locked')) throw e; await new Promise(r=>setTimeout(r,5)); }
		} if(!done) throw Error('lock retry budget exceeded'); }`;
	await Promise.all(["first", "second"].map((main) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, file, main], { cwd: f.scratch, timeout: 5000 })));
	assert.equal(readPolicy(undefined, file).pairings.size, 16);
	assert.deepEqual(readdirSync(join(file, "..")), ["advisor.json"]);
});

test("pre-commit failure preserves config; post-commit cleanup failure is reported as saved", (t) => {
	const file = path();
	const original = '{"pairings":{"main/one":"reviewer/old"}}';
	writeFileSync(file, original);
	const rename = t.mock.method(fs, "renameSync", () => { throw new Error("simulated rename failure"); });
	syncBuiltinESMExports();
	try {
		assert.throws(() => savePairing(file, "main/one", null), /simulated rename/);
		assert.equal(readFileSync(file, "utf8"), original);
		assert.deepEqual(readdirSync(join(file, "..")), ["advisor.json"]);
	} finally { rename.mock.restore(); syncBuiltinESMExports(); }
	const realUnlink = fs.unlinkSync;
	const unlink = t.mock.method(fs, "unlinkSync", (target) => {
		if (target === `${file}.lock`) throw new Error("simulated lock cleanup failure");
		return realUnlink(target);
	});
	syncBuiltinESMExports();
	try {
		assert.match(savePairing(file, "main/one", null), /Pairing saved, but cleanup failed/);
		assert.equal(readPolicy(undefined, file).pairings.get("main/one"), null);
	} finally { unlink.mock.restore(); syncBuiltinESMExports(); unlinkSync(`${file}.lock`); }
});

test("session choices survive reload/resume, ignore branch location, and never leak to a new/forked session", () => {
	const entry = (data) => ({ type: "custom", customType: CHOICE_ENTRY, data });
	const entries = [entry(sessionChoice("session", "reviewer/one")), entry(sessionChoice("session", null))];
	assert.equal(restoreChoice(entries, "session", undefined), null);
	assert.equal(restoreChoice(entries, "session", "reviewer/cli"), null, "A later command wins over this process's startup flag");
	assert.equal(restoreChoice(entries, "new-session", undefined), undefined);
	const oldProcess = [entry({ ...sessionChoice("session", "reviewer/one"), launch: "previous-process" })];
	assert.equal(restoreChoice(oldProcess, "session", undefined), "reviewer/one");
	assert.equal(restoreChoice(oldProcess, "session", "none"), undefined, "A new explicit CLI override beats restored choices");
	assert.equal(restoreChoice([...oldProcess, entry({ sessionId: "session", model: "bad" })], "session", undefined), "reviewer/one");
});
