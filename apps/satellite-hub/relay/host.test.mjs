import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const relayDll = 'apps/satellite-hub/relay/psfn-voxta-relay/bin/Debug/net8.0/PsfnVoxtaRelay.dll';
const token = 'invented-host-fixture-stored-credential';
const hostile = 'hostile.example.test';

for (const host of ['127.0.0.1', '::1']) {
  test(`relay ${host} binds HTTP and SignalR authority before credential or session side effects`, async t => {
    const reservation = http.createServer();
    try {
      reservation.listen(0, host);
      await once(reservation, 'listening');
    } catch (error) {
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) {
        t.skip('IPv6 loopback is unavailable on this host');
        return;
      }
      throw error;
    }
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const authority = `${host === '::1' ? '[::1]' : host}:${port}`;
    const listenUrl = `http://${authority}`;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voxta-relay-host-'));
    const audioFolder = path.join(scratch, 'audio');
    const upstreamRequests = [];
    const upstreamSockets = new WebSocketServer({ noServer: true });
    const upstream = http.createServer((request, response) => {
      upstreamRequests.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url.startsWith('/hub/negotiate')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          negotiateVersion: 1, connectionId: 'fixture', connectionToken: 'fixture',
          availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
        }));
      } else {
        response.end(JSON.stringify({ storedBearerInjected: request.headers.authorization === `Bearer ${token}` }));
      }
    });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamRequests.push({ url: request.url, authorization: request.headers.authorization });
      upstreamSockets.handleUpgrade(request, socket, head, client => upstreamSockets.emit('connection', client));
    });
    upstreamSockets.on('connection', socket => socket.on('message', raw => {
      for (const frame of raw.toString().split('\x1e').filter(Boolean)) {
        const message = JSON.parse(frame);
        if (message.protocol) socket.send('{}\x1e');
        if (message.target === 'SendMessage') socket.send(`${JSON.stringify({
          type: 1, target: 'ReceiveMessage', arguments: [{ $type: 'fixtureReply' }],
        })}\x1e`);
      }
    }));
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const relay = spawn('dotnet', [relayDll, '--listen', listenUrl,
      '--remote', `http://127.0.0.1:${upstream.address().port}`], {
      cwd: repoRoot,
      env: { ...process.env, PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN: token,
        PSFN_VOXTA_RELAY_AUDIO_FOLDER: audioFolder, ASPNETCORE_ENVIRONMENT: 'Production',
        Logging__LogLevel__Default: 'Trace' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    relay.stdout.on('data', data => { output += data.toString(); });
    relay.stderr.on('data', data => { output += data.toString(); });
    const request = (route, headers = {}, method = 'GET') => httpRequest(host, port, route, { Host: authority, ...headers }, method);
    const sockets = [];
    try {
      await waitFor(async () => {
        assert.equal(relay.exitCode, null, 'Relay exited before listening');
        try { return (await request('/')).status === 200; } catch { return false; }
      });
      // This exact regression returned 200 with storedBearerInjected:true before
      // the fix, despite the absence of browser Origin metadata.
      const result = await request('/api/private-fixture', { Host: `${hostile}:${port}` });
      assert.equal(result.status, 403, `Hostile Host reached upstream: ${result.body}`);
      assert.equal(result.body, '');
      for (const headers of [
        { Host: `${hostile}:${port}`, Origin: listenUrl },
        { Host: `${hostile}:${port}`, Forwarded: `host="${authority}";proto=http`, 'X-Forwarded-Host': authority },
        { Host: `127.0.0.1.${hostile}:${port}` },
        { Host: `localhost:${port}` },
        { Host: `${host === '::1' ? '127.0.0.1' : '[::1]'}:${port}` },
        { Host: `${host === '::1' ? '[::1]' : host}:${port === 65535 ? port - 1 : port + 1}` },
        { Origin: `http://${hostile}:${port}` },
        { Origin: `${listenUrl}/` },
        { Origin: 'null' },
      ]) {
        for (const [route, method] of [['/', 'GET'], ['/api/private-fixture', 'GET'], ['/hub/negotiate?negotiateVersion=1', 'POST']]) {
          assert.deepEqual(await request(route, headers, method), { status: 403, body: '' });
        }
      }
      for (const raw of [
        `GET /api/private-fixture HTTP/1.1\r\nHost: ${authority}\r\nHost: ${authority}\r\n`,
        `GET /api/private-fixture HTTP/1.1\r\nHost: ${authority}\r\nOrigin: ${listenUrl}\r\nOrigin: ${listenUrl}\r\n`,
        `GET http://${hostile}:${port}/api/private-fixture HTTP/1.1\r\nHost: ${authority}\r\n`,
        `GET ${listenUrl}/api/private-fixture HTTP/1.1\r\nHost: ${hostile}:${port}\r\n`,
      ]) {
        const denied = await rawRequest(host, port, `${raw}Connection: close\r\n\r\n`);
        assert.match(denied, /^HTTP\/1\.1 (400|403) /);
        assert.equal(denied.split('\r\n\r\n')[1], '');
      }
      const negotiated = await request('/hub/negotiate?negotiateVersion=1', {}, 'POST');
      assert.equal(negotiated.status, 200);
      const { connectionToken } = JSON.parse(negotiated.body);
      for (const headers of [
        { Host: `${hostile}:${port}` },
        { Host: `${hostile}:${port}`, Origin: listenUrl },
        { Host: authority, Origin: `http://${hostile}:${port}` },
      ]) {
        for (const route of ['/hub', `/hub?id=${connectionToken}`]) {
          assert.deepEqual(await deniedUpgrade(`ws://${authority}${route}`, headers), { status: 403, body: '' });
        }
      }
      // The accepted local negotiate has not opened a remote bridge. All denied
      // REST and upgrade traffic must remain behind the same boundary.
      assert.deepEqual(upstreamRequests, []);
      assert.deepEqual(fs.readdirSync(audioFolder), []);
      assert.doesNotMatch(output, /session\.|client\.registered|microphone\.|audio\.downloaded/);

      for (const headers of [{}, { Origin: listenUrl }, { Forwarded: `host=${hostile}`, 'X-Forwarded-Host': hostile }]) {
        const allowed = await request('/api/private-fixture', headers);
        assert.equal(allowed.status, 200);
        assert.deepEqual(JSON.parse(allowed.body), { storedBearerInjected: true });
      }
      // Both native no-Origin and browser-Origin upgrades must still work after
      // the rejected attempts, including reuse of the unconsumed negotiate token.
      for (const [route, headers] of [[`/hub?id=${connectionToken}`, {}], ['/hub', { Origin: listenUrl }]]) {
        const socket = new WebSocket(`ws://${authority}${route}`, { headers });
        sockets.push(socket);
        const frames = [];
        socket.on('message', raw => {
          for (const frame of raw.toString().split('\x1e').filter(Boolean)) frames.push(JSON.parse(frame));
        });
        await once(socket, 'open');
        socket.send('{"protocol":"json","version":1}\x1e');
        await waitFor(() => frames.some(frame => Object.keys(frame).length === 0));
        socket.send('{"type":1,"target":"SendMessage","arguments":[{"$type":"fixtureRequest"}]}\x1e');
        await waitFor(() => frames.some(frame => frame.arguments?.[0]?.$type === 'fixtureReply'));
        socket.close();
        await once(socket, 'close');
      }
      assert.equal(upstreamRequests.length, 7, 'Only three approved REST calls and two negotiated bridges reach upstream');
      assert.ok(upstreamRequests.every(request => request.authorization === `Bearer ${token}`));
      assert.deepEqual(fs.readdirSync(audioFolder), []);
    } finally {
      for (const socket of sockets) socket.terminate();
      relay.kill('SIGTERM');
      await once(relay, 'exit');
      for (const socket of upstreamSockets.clients) socket.terminate();
      await new Promise(resolve => upstreamSockets.close(resolve));
      await new Promise(resolve => upstream.close(resolve));
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    assert.equal(output.includes(hostile), false, 'Host/Origin attacker content escaped into process logs');
    assert.equal(output.includes(token), false, 'The stored bearer escaped into process logs');
    for (const line of output.trim().split('\n')) JSON.parse(line);
  });
}

function httpRequest(hostname, port, route, headers, method) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname, port, path: route, headers, method }, response => {
      let body = '';
      response.on('data', data => { body += data; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Relay HTTP request timed out')));
    outgoing.end();
  });
}

function rawRequest(host, port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => socket.write(payload));
    let response = '';
    socket.on('data', data => { response += data; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw relay request timed out')));
  });
}

function deniedUpgrade(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 5000 });
    socket.on('error', reject);
    socket.on('open', () => { socket.terminate(); reject(new Error('Untrusted WebSocket upgraded')); });
    socket.on('unexpected-response', (_, response) => {
      let body = '';
      response.on('data', data => { body += data; });
      response.on('end', () => {
        socket.terminate();
        resolve({ status: response.statusCode, body });
      });
    });
  });
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for relay authority test traffic');
}
