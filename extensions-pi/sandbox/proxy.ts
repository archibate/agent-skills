/**
 * Per-call egress proxy for networkAccess "fetch-only". The sandbox has no network namespace of its
 * own beyond loopback; a socat relay inside forwards 127.0.0.1:3128 to this proxy's Unix socket.
 *
 * It accepts CONNECT tunnels and absolute-URI plain-HTTP requests, chains to the host's own
 * http(s)_proxy (honoring no_proxy), and refuses loopback, private, link-local, and multicast
 * destinations, so localhost services (CDP, VNC, proxy controllers) stay unreachable. It does not
 * inspect HTTPS, so request methods are not enforced: "fetch-only" is a declaration, the proxy only
 * contains where traffic can go. Destinations are recorded for the reviewer.
 */

import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

export interface ProxyHandle {
	socketPath: string;
	/** Destinations the sandbox reached, as host:port. */
	hosts: Set<string>;
	/** Refused destinations with the reason. */
	denied: Map<string, string>;
	close(): Promise<void>;
}

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	blocked.addSubnet(net, prefix, "ipv6");
}

export function isBlockedAddress(address: string): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return blocked.check(mapped[1]!, "ipv4");
	const family = isIP(address);
	if (family === 0) return true;
	return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const name = host.toLowerCase();
	for (const raw of noProxy.split(",")) {
		let entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") return true;
		entry = entry.replace(/:\d+$/, "").replace(/^\*?\./, "");
		if (name === entry || name.endsWith(`.${entry}`)) return true;
	}
	return false;
}

/** Upstream HTTP proxy for `host`, from the host environment, or undefined to connect directly. */
export function upstreamFor(host: string, secure: boolean, env: NodeJS.ProcessEnv): URL | undefined {
	if (matchesNoProxy(host, env.no_proxy ?? env.NO_PROXY)) return undefined;
	const raw = secure
		? (env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY)
		: (env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY);
	if (!raw) return undefined;
	try {
		const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
		return url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
}

type Destination = { ok: true; address: string | undefined } | { ok: false; reason: string };

async function checkDestination(host: string): Promise<Destination> {
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (name === "localhost" || name.endsWith(".localhost")) return { ok: false, reason: "local address" };
	if (isIP(name)) return isBlockedAddress(name) ? { ok: false, reason: "local or private address" } : { ok: true, address: name };
	try {
		const addresses = await lookup(name, { all: true });
		if (addresses.some((entry) => isBlockedAddress(entry.address))) {
			return { ok: false, reason: "resolves to a local or private address" };
		}
		return { ok: true, address: addresses[0]?.address };
	} catch {
		// Unresolvable here; an upstream proxy may still resolve it.
		return { ok: true, address: undefined };
	}
}

function proxyAuthorization(upstream: URL): string | undefined {
	if (!upstream.username) return undefined;
	const credentials = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
	return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/** Open a raw TCP tunnel to host:port, through the upstream proxy when one applies. */
function openTunnel(host: string, port: number, address: string | undefined, env: NodeJS.ProcessEnv): Promise<Socket> {
	const upstream = upstreamFor(host, true, env);
	return new Promise((resolve, reject) => {
		if (!upstream) {
			if (!address) {
				reject(new Error(`cannot resolve ${host}`));
				return;
			}
			const socket = connect(port, address, () => resolve(socket));
			socket.once("error", reject);
			return;
		}
		const socket = connect(Number(upstream.port || 80), upstream.hostname, () => {
			const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
			const auth = proxyAuthorization(upstream);
			socket.write(
				`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
			);
		});
		let head = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end === -1) {
				if (head.length > 16 * 1024) fail(new Error("oversized upstream proxy response"));
				return;
			}
			socket.off("data", onData);
			const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"));
			if (status?.[1] !== "200") {
				fail(new Error(`upstream proxy refused CONNECT (${status?.[1] ?? "bad response"})`));
				return;
			}
			const rest = head.subarray(end + 4);
			if (rest.length > 0) socket.unshift(rest);
			socket.off("error", fail);
			resolve(socket);
		};
		const fail = (error: Error) => {
			socket.destroy();
			reject(error);
		};
		socket.on("data", onData);
		socket.once("error", fail);
	});
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
	try {
		const url = new URL(`http://${authority}`);
		return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443) };
	} catch {
		return undefined;
	}
}

function refuse(socket: Socket, status: string, reason: string): void {
	socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\npi-sandbox fetch-only: ${reason}\n`);
}

export async function startProxy(socketPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ProxyHandle> {
	const hosts = new Set<string>();
	const denied = new Map<string, string>();
	const connections = new Set<Socket>();
	const server = createServer();

	server.on("connection", (socket: Socket) => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
	});

	server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
		client.on("error", () => client.destroy());
		const target = parseAuthority(req.url ?? "");
		if (!target) {
			refuse(client, "400 Bad Request", "malformed CONNECT target");
			return;
		}
		const label = `${target.host}:${target.port}`;
		const check = await checkDestination(target.host);
		if (!check.ok) {
			denied.set(label, check.reason);
			refuse(client, "403 Forbidden", `${label} is blocked (${check.reason})`);
			return;
		}
		let remote: Socket;
		try {
			remote = await openTunnel(target.host, target.port, check.address, env);
		} catch (error) {
			refuse(client, "502 Bad Gateway", error instanceof Error ? error.message : String(error));
			return;
		}
		hosts.add(label);
		connections.add(remote);
		remote.once("close", () => connections.delete(remote));
		remote.on("error", () => client.destroy());
		client.on("close", () => remote.destroy());
		remote.on("close", () => client.destroy());
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) remote.write(head);
		client.pipe(remote);
		remote.pipe(client);
	});

	server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "");
		} catch {
			res.writeHead(400, { "content-type": "text/plain" }).end("pi-sandbox fetch-only: expected a proxy request\n");
			return;
		}
		if (url.protocol !== "http:") {
			res.writeHead(400, { "content-type": "text/plain" }).end(`pi-sandbox fetch-only: unsupported scheme ${url.protocol}\n`);
			return;
		}
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const port = Number(url.port || 80);
		const label = `${host}:${port}`;
		const check = await checkDestination(host);
		if (!check.ok) {
			denied.set(label, check.reason);
			res.writeHead(403, { "content-type": "text/plain" }).end(`pi-sandbox fetch-only: ${label} is blocked (${check.reason})\n`);
			return;
		}
		const headers = { ...req.headers };
		delete headers["proxy-connection"];
		delete headers["proxy-authorization"];
		const upstream = upstreamFor(host, false, env);
		if (!upstream && !check.address) {
			res.writeHead(502, { "content-type": "text/plain" }).end(`pi-sandbox fetch-only: cannot resolve ${host}\n`);
			return;
		}
		const auth = upstream ? proxyAuthorization(upstream) : undefined;
		if (auth) headers["proxy-authorization"] = auth;
		hosts.add(label);
		const outgoing = httpRequest(
			upstream
				? { host: upstream.hostname, port: Number(upstream.port || 80), method: req.method, path: url.href, headers }
				: { host: check.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers },
			(incoming) => {
				res.writeHead(incoming.statusCode ?? 502, incoming.headers);
				incoming.pipe(res);
			},
		);
		outgoing.on("error", (error) => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end(`pi-sandbox fetch-only: ${error.message}\n`);
		});
		req.pipe(outgoing);
	});

	// Plain-HTTP upgrades (ws://) would turn into an uninspected bidirectional stream; wss:// uses CONNECT.
	server.on("upgrade", (_req: IncomingMessage, socket: Socket) => refuse(socket, "403 Forbidden", "protocol upgrades are not proxied"));

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	let closed: Promise<void> | undefined;
	return {
		socketPath,
		hosts,
		denied,
		close() {
			closed ??= new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of connections) socket.destroy();
			});
			return closed;
		},
	};
}
