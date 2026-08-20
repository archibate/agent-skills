#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = join(ROOT, 'skills/chrome-cdp/scripts/cdp.mjs');
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'chrome-cdp-startup.'));

function cleanup() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function makeCase(name, port) {
  const caseRoot = join(TEST_ROOT, name);
  const runtimeDir = join(caseRoot, 'runtime');
  const portFile = join(caseRoot, 'DevToolsActivePort');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(portFile, `${port}\n/devtools/browser/test\n`);
  const env = {
    ...process.env,
    CDP_PORT_FILE: portFile,
    XDG_RUNTIME_DIR: runtimeDir,
  };
  delete env.CODEX_SANDBOX_NETWORK_DISABLED;
  return { env };
}

function runCdp(env, timeoutMs = 10000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CDP, 'list'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`cdp list exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen(server.address().port);
    });
  });
}

function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  return new Promise(resolveClose => server.close(resolveClose));
}

function websocketAccept(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  assert.ok(payload.length < 126, 'test response unexpectedly needs an extended WebSocket frame');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function decodeClientFrame(buffer) {
  if (buffer.length < 6) return undefined;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 8) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 14) return undefined;
    const wideLength = buffer.readBigUInt64BE(2);
    assert.ok(wideLength <= BigInt(Number.MAX_SAFE_INTEGER));
    payloadLength = Number(wideLength);
    offset = 10;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const frameLength = offset + (masked ? 4 : 0) + payloadLength;
  if (buffer.length < frameLength) return undefined;
  let payload = buffer.subarray(offset + (masked ? 4 : 0), frameLength);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { payload, rest: buffer.subarray(frameLength) };
}

function createFakeCdpServer(sockets) {
  return net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headers = buffer.subarray(0, headerEnd).toString();
        const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/im)?.[1]?.trim();
        assert.ok(key, 'WebSocket upgrade request omitted Sec-WebSocket-Key');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`
        );
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
      }
      for (;;) {
        const frame = decodeClientFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        const request = JSON.parse(frame.payload.toString());
        if (request.method === 'Target.getTargets') {
          socket.write(encodeTextFrame({ id: request.id, result: { targetInfos: [] } }));
        }
      }
    });
  });
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function sandboxDiagnostic() {
  const { env } = makeCase('sandbox', 9222);
  env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
  const result = await runCdp(env);
  const context = JSON.stringify(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /network access disabled/, context);
  assert.match(result.stderr, /outside the sandbox/, context);
  assert.match(result.stderr, /do not ask the user to click Chrome "Allow"/, context);
}

async function tcpRefusalDiagnostic() {
  const port = await unusedPort();
  const { env } = makeCase('refused', port);
  const result = await runCdp(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot reach Chrome DevTools/);
  assert.match(result.stderr, /before the WebSocket handshake/);
  assert.match(result.stderr, /Chrome "Allow" is not the issue/);
}

async function websocketRejectionDiagnostic() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  });
  const port = await listen(server);
  const { env } = makeCase('rejected', port);
  const result = await runCdp(env);
  await closeServer(server, sockets);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Chrome CDP hub failed to start:/);
  assert.doesNotMatch(result.stderr, /did you click Allow/);
}

async function successfulHubStartup() {
  const sockets = new Set();
  const server = createFakeCdpServer(sockets);
  const port = await listen(server);
  const { env } = makeCase('success', port);
  const result = await runCdp(env);
  await closeServer(server, sockets);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.stdout, '\n');
  assert.equal(result.stderr, '');
}

async function pendingAllowDiagnostic() {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  const { env } = makeCase('pending', port);
  const result = await runCdp(env);
  await closeServer(server, sockets);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepted TCP/);
  assert.match(result.stderr, /WebSocket handshake did not complete/);
  assert.match(result.stderr, /"Allow debugging" prompt/);
}

const cases = [
  ['sandbox diagnostic', sandboxDiagnostic],
  ['TCP refusal diagnostic', tcpRefusalDiagnostic],
  ['WebSocket rejection diagnostic', websocketRejectionDiagnostic],
  ['successful Hub startup', successfulHubStartup],
  ['pending Allow diagnostic', pendingAllowDiagnostic],
];

for (const [name, run] of cases) {
  await run();
  process.stdout.write(`ok - ${name}\n`);
}
