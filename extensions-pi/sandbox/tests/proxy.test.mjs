import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { connect, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { isBlockedAddress, matchesNoProxy, startProxy, upstreamFor } from "../proxy.ts";

test("blocked address ranges", () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "not-an-ip"]) {
		assert.equal(isBlockedAddress(address), true, address);
	}
	for (const address of ["93.184.215.14", "198.18.0.5", "2606:4700::1111", "::ffff:8.8.8.8"]) {
		assert.equal(isBlockedAddress(address), false, address);
	}
});

test("no_proxy matching and upstream selection", () => {
	assert.equal(matchesNoProxy("api.deepseek.com", "localhost,api.deepseek.com"), true);
	assert.equal(matchesNoProxy("x.example.com", ".example.com"), true);
	assert.equal(matchesNoProxy("example.com", "*.example.com"), true);
	assert.equal(matchesNoProxy("notexample.com", "example.com"), false);
	assert.equal(matchesNoProxy("anything", "*"), true);
	const env = { https_proxy: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7891", no_proxy: "direct.test" };
	assert.equal(upstreamFor("a.test", true, env)?.port, "7890");
	assert.equal(upstreamFor("a.test", false, env)?.port, "7891");
	assert.equal(upstreamFor("direct.test", true, env), undefined);
	assert.equal(upstreamFor("a.test", true, { all_proxy: "socks5://127.0.0.1:1080" }), undefined);
});

/** Send raw bytes over the proxy's Unix socket and collect the reply until the server closes. */
function rawRequest(socketPath, text) {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath, () => socket.write(text));
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk;
		});
		socket.on("close", () => resolve(data));
		socket.on("error", reject);
		setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, 2000).unref();
	});
}

test("proxy refuses local destinations and tunnels public ones through the upstream", async (t) => {
	const dir = mkdtempSync(join(homedir(), ".cache", "pi-sandbox-proxy-"));
	// A local service the sandbox must not reach.
	const local = createServer((_req, res) => res.end("secret"));
	await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
	// A fake upstream proxy: answers CONNECT, then echoes the tunnelled bytes in uppercase.
	const seen = [];
	const upstream = createTcpServer((socket) => {
		socket.once("data", (head) => {
			seen.push(head.toString("latin1").split("\r\n")[0]);
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.on("data", (chunk) => socket.end(chunk.toString().toUpperCase()));
		});
	});
	await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const proxy = await startProxy(join(dir, "proxy.sock"), { https_proxy: `http://127.0.0.1:${upstream.address().port}` });
	t.after(async () => {
		await proxy.close();
		local.close();
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const localPort = local.address().port;
	const plain = await rawRequest(
		proxy.socketPath,
		`GET http://127.0.0.1:${localPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
	);
	assert.match(plain, /^HTTP\/1\.1 403/);
	assert.doesNotMatch(plain, /secret/);
	const tunnel = await rawRequest(proxy.socketPath, `CONNECT localhost:${localPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
	assert.match(tunnel, /^HTTP\/1\.1 403/);
	assert.equal(proxy.denied.get(`localhost:${localPort}`), "local address");

	// A public IP literal needs no DNS, so this stays offline: the fake upstream answers.
	const reply = await rawRequest(proxy.socketPath, "CONNECT 93.184.215.14:443 HTTP/1.1\r\nHost: 93.184.215.14:443\r\n\r\nhello");
	assert.match(reply, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHELLO/);
	assert.deepEqual(seen, ["CONNECT 93.184.215.14:443 HTTP/1.1"]);
	assert.ok(proxy.hosts.has("93.184.215.14:443"));
});
