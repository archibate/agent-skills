/**
 * Recognize a job_start command that is exactly one bounded pi subagent launch:
 *
 *     [cd DIR &&] pi -p [flags] --permissions VALUE [prompt...]
 *
 * Such a child runs unsandboxed, since pi needs its API network and session files, but its own
 * tool calls are bounded by VALUE with the deny reviewer. Its access is therefore VALUE.
 *
 * Fails closed: anything else returns undefined and gets an ordinary review. That includes other
 * shell syntax (pipes, chains, redirections, substitutions, globs, assignments), unknown pi flags
 * (they could drop extensions or change review), and a reviewer other than deny. "$NAME" expansions
 * are accepted only inside double quotes and only where pi does not interpret the value as access.
 */

import { resolve } from "node:path";
import { expandPath } from "./policy.ts";

interface Word {
	text: string;
	/** Contains a $NAME expansion, so its runtime value is unknown. */
	dynamic: boolean;
}

const SAFE_UNQUOTED = /[A-Za-z0-9_@%+=:,./-]/;

/** Split a command into words and `&&`; undefined when it uses anything else. */
function lex(command: string): Array<Word | "&&"> | undefined {
	const tokens: Array<Word | "&&"> = [];
	let i = 0;
	while (i < command.length) {
		const ch = command.charAt(i);
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		if (command.startsWith("&&", i)) {
			tokens.push("&&");
			i += 2;
			continue;
		}
		let text = "";
		let dynamic = false;
		let started = false;
		while (i < command.length && command[i] !== " " && command[i] !== "\t") {
			const c = command.charAt(i);
			if (c === "'") {
				const end = command.indexOf("'", i + 1);
				if (end < 0) return undefined;
				text += command.slice(i + 1, end);
				i = end + 1;
			} else if (c === '"') {
				i++;
				for (;;) {
					if (i >= command.length) return undefined;
					const d = command.charAt(i);
					if (d === '"') break;
					if (d === "`") return undefined;
					if (d === "\\" && i + 1 < command.length && '"\\$`'.includes(command.charAt(i + 1))) {
						text += command.charAt(i + 1);
						i += 2;
						continue;
					}
					if (d === "$") {
						const name = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(command.slice(i));
						if (!name) return undefined;
						text += name[0];
						dynamic = true;
						i += name[0].length;
						continue;
					}
					text += d;
					i++;
				}
				i++;
			} else if (SAFE_UNQUOTED.test(c)) {
				text += c;
				i++;
			} else {
				return undefined;
			}
			started = true;
		}
		if (started) tokens.push({ text, dynamic });
	}
	return tokens;
}

/**
 * pi flags a bounded launch may use. pi's own value flags always take the next word (cli/args.js);
 * extension flags also accept --flag=value, and take the next word only if it does not start with
 * "-" or "@".
 */
const BUILTIN_VALUE_FLAGS = new Set([
	"--fork",
	"--session",
	"--session-id",
	"--model",
	"--provider",
	"--thinking",
	"--append-system-prompt",
	"--tools",
	"-t",
	"--mode",
]);
const EXTENSION_VALUE_FLAGS = new Set(["--permissions", "--reviewer"]);
const SWITCH_FLAGS = new Set(["-p", "--print", "--no-session"]);
/** Values pi interprets as access or mode; these must be literal. */
const LITERAL_FLAGS = new Set(["--permissions", "--reviewer", "--mode", "--tools", "-t"]);

export interface SubagentLaunch {
	/** The child's working directory, against which its --permissions paths resolve. */
	cwd: string;
	/** The literal --permissions value. */
	permissions: string;
}

export function parseSubagentLaunch(command: string, cwd: string, home: string): SubagentLaunch | undefined {
	const tokens = lex(command);
	if (!tokens) return undefined;
	let rest = tokens;
	let childCwd = cwd;
	const first = rest[0];
	if (first && first !== "&&" && first.text === "cd") {
		const dir = rest[1];
		if (!dir || dir === "&&" || dir.dynamic || rest[2] !== "&&") return undefined;
		childCwd = resolve(expandPath(dir.text, cwd, home));
		rest = rest.slice(3);
	}
	const words = rest.filter((token): token is Word => token !== "&&");
	if (words.length !== rest.length) return undefined;
	if (words[0]?.text !== "pi" || words[0].dynamic) return undefined;
	let print = false;
	let permissions: string | undefined;
	let reviewer = "deny";
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (!word) return undefined;
		if (!word.text.startsWith("-")) {
			// Prompt text or @file. An expansion here could turn into a flag at run time.
			if (word.dynamic) return undefined;
			continue;
		}
		const eq = word.text.indexOf("=");
		const flag = eq > 0 ? word.text.slice(0, eq) : word.text;
		let value: Word | undefined;
		if (SWITCH_FLAGS.has(word.text)) {
			if (word.text !== "--no-session") print = true;
			continue;
		} else if (BUILTIN_VALUE_FLAGS.has(word.text)) {
			value = words[++i];
		} else if (EXTENSION_VALUE_FLAGS.has(flag)) {
			if (eq > 0) value = { text: word.text.slice(eq + 1), dynamic: word.dynamic };
			else {
				value = words[++i];
				if (value && /^[-@]/.test(value.text)) return undefined;
			}
		} else return undefined;
		if (!value) return undefined;
		if (LITERAL_FLAGS.has(flag) && value.dynamic) return undefined;
		if (flag === "--permissions") {
			if (permissions !== undefined) return undefined;
			permissions = value.text;
		} else if (flag === "--reviewer") reviewer = value.text;
		else if (flag === "--mode" && value.text !== "text" && value.text !== "json") return undefined;
	}
	if (!print || permissions === undefined || reviewer !== "deny") return undefined;
	return { cwd: childCwd, permissions };
}
