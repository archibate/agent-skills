import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentLaunch } from "../subagent.ts";

const parse = (command) => parseSubagentLaunch(command, "/work", "/home/u");

test("bounded launches, including the pi-subagents skill forms", () => {
	assert.deepEqual(parse('pi -p --permissions read-only "Task: review"'), { cwd: "/work", permissions: "read-only" });
	assert.deepEqual(
		parse(
			'pi -p --fork "$PI_SESSION_ID" --session-id "$PI_SESSION_ID.review" --permissions read-only "You are a forked subagent; do not spawn subagents."',
		),
		{ cwd: "/work", permissions: "read-only" },
	);
	assert.deepEqual(
		parse(
			`pi -p --session-id "$PI_SESSION_ID.audit" --model "$PI_PROVIDER/$PI_MODEL" --thinking "$PI_REASONING_LEVEL" --append-system-prompt "You are a subagent." --permissions '{"writableLocations":["src"]}' "Audit src/"`,
		),
		{ cwd: "/work", permissions: '{"writableLocations":["src"]}' },
	);
	assert.deepEqual(parse("cd sub && pi --print --no-session --permissions=default --reviewer deny 'x'"), {
		cwd: "/work/sub",
		permissions: "default",
	});
	assert.deepEqual(parse("pi -p --mode json --tools read,grep --permissions read-only @notes.md x").permissions, "read-only");
	assert.equal(parse("pi -p --permissions read-only 'it'\"'\"'s'").permissions, "read-only", "adjacent quotes join");
});

test("anything else is not recognized", () => {
	const rejected = [
		'pi -p "x"', // no --permissions
		"pi --permissions read-only x", // not print mode
		"pi -p --permissions read-only --reviewer manual x",
		"pi -p --permissions read-only --no-extensions x",
		"pi -p --permissions read-only -e ./evil.ts x",
		"pi -p --permissions read-only --extension ./evil.ts x",
		"pi -p --permissions read-only --mode rpc",
		"pi -p --permissions read-only --permissions default x",
		'pi -p --permissions "$P" x', // access must be literal
		"pi -p --permissions --no-extensions x", // extension flag followed by a flag is a bare switch
		'pi -p --permissions read-only "$PROMPT"', // expansion in prompt position could become a flag
		"pi -p --permissions read-only -- --no-extensions",
		"pi -p --permissions read-only x; rm -rf ~",
		"pi -p --permissions read-only x | tee log",
		"pi -p --permissions read-only x > out",
		"pi -p --permissions read-only $(cat prompt)",
		'pi -p --permissions read-only "$(cat prompt)"',
		"pi -p --permissions read-only `cat prompt`",
		"PATH=/tmp/x:$PATH pi -p --permissions read-only x",
		"env pi -p --permissions read-only x",
		"/tmp/pi -p --permissions read-only x",
		"cd $HOME && pi -p --permissions read-only x",
		"cd a && cd b && pi -p --permissions read-only x",
		"true && pi -p --permissions read-only x",
		"pi -p --permissions read-only x &",
		"pi -p --permissions read-only 'unterminated",
		"pi -p --permissions read-only *",
		"pi -p --permissions read-only x\npi -p y",
	];
	for (const command of rejected) assert.equal(parse(command), undefined, command);
});
