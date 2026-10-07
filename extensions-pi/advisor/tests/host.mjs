import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
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
	const scratch = mkdtempSync(join(process.env.PI_SCRATCHPAD_DIR ?? tmpdir(), "advisor-test-"));
	cpSync(fileURLToPath(new URL("..", import.meta.url)), join(scratch, "extension"), { recursive: true });
	mkdirSync(join(scratch, "node_modules/@earendil-works"), { recursive: true });
	for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent"]) symlinkSync(join(host, "..", name), join(scratch, "node_modules/@earendil-works", name));
	return { host, scratch, load: (path) => import(join(scratch, "extension", path)), cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}
