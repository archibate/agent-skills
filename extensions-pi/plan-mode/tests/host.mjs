import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export function fixture() {
	let host = process.env.PI_SDK_PATH ? dirname(dirname(process.env.PI_SDK_PATH))
		: dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
	while (!existsSync(join(host, "package.json"))) {
		const version = join(host, "install/current-version");
		if (existsSync(version)) {
			host = join(host, "install/releases", readFileSync(version, "utf8").trim(), "node_modules/@earendil-works/pi-coding-agent");
			break;
		}
		if (dirname(host) === host) throw new Error("Cannot locate Pi; set PI_SDK_PATH to its dist/index.js.");
		host = dirname(host);
	}
	const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "plan-test-"));
	cpSync(fileURLToPath(new URL("..", import.meta.url)), join(scratch, "extension"), { recursive: true });
	// Type-only optional integration resolves during tsc; integration tests load this same private copy.
	cpSync(fileURLToPath(new URL("../../sandbox", import.meta.url)), join(scratch, "sandbox"), {
		recursive: true, filter: (path) => !["node_modules", "tests"].includes(basename(path)),
	});
	mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
	for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"]) symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
	for (const name of ["typebox", "@types"]) symlinkSync(resolve(host, "../..", name), join(scratch, "node_modules", name));
	return { host, scratch, load: (path) => import(join(scratch, "extension", path)), loadSandbox: (path) => import(join(scratch, "sandbox", path)), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}
