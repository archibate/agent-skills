import assert from "node:assert/strict";
import { test } from "node:test";
import { argvRequestsSandbox, sandboxRequested } from "../enable.ts";

test("the sandbox is off unless a flag asks for it", () => {
	assert.equal(sandboxRequested({}, []), false);
	assert.equal(sandboxRequested({}, ["node", "pi", "-c"]), false);
	assert.equal(sandboxRequested({ enable: false, permissions: "", reviewer: "  " }, []), false);
});

test("--enable-sandbox, --permissions, and --reviewer each enable it", () => {
	assert.equal(sandboxRequested({ enable: true }, []), true);
	assert.equal(sandboxRequested({ permissions: "read-only" }, []), true);
	assert.equal(sandboxRequested({ reviewer: "deny" }, []), true);
	assert.equal(sandboxRequested({}, ["pi", "--enable-sandbox"]), true);
	assert.equal(sandboxRequested({}, ["pi", "--permissions=read-only"]), true);
	assert.equal(sandboxRequested({}, ["pi", "--reviewer", "manual"]), true);
});

test("argv scanning stops at -- and ignores non-flag or unrelated tokens", () => {
	assert.equal(argvRequestsSandbox(["--", "--enable-sandbox"]), false);
	assert.equal(argvRequestsSandbox(["pi", "a --enable-sandbox b"]), false);
	assert.equal(argvRequestsSandbox(["-p", "--permissions-extra"]), false);
	assert.equal(argvRequestsSandbox(["pi", "--permissions"]), true);
	assert.equal(argvRequestsSandbox(["pi", "--permissions="]), true, "presence enables; the value is validated later");
});
