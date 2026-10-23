import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const relayDll = 'apps/satellite-hub/relay/psfn-voxta-relay/bin/Debug/net8.0/PsfnVoxtaRelay.dll';
const sentinels = {
  transcript: 'invented-private-transcript-86e4',
  reply: 'invented-private-reply-4b13',
  filename: 'invented-private-audio-filename-cf08',
  query: 'invented-private-query-credential-a730',
  folder: 'invented-private-folder-54b8',
  session: 'invented-private-session-9d28',
  connection: 'invented-private-connection-127a',
  exception: 'invented-private-exception-91ac',
  token: 'invented-private-bearer-token-4219',
};

for (const level of ['Information', 'Trace']) {
  test(`relay ${level} logs preserve operational events without private data or injection`, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voxta-relay-privacy-'));
    const audioFolder = path.join(scratch, sentinels.folder);
    const upstreamSockets = new WebSocketServer({ noServer: true });
    const upstream = http.createServer((request, response) => {
      if (request.url.startsWith('/hub/negotiate')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          negotiateVersion: 1, connectionId: sentinels.connection, connectionToken: sentinels.connection,
          availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
        }));
        return;
      }
      if (request.url.startsWith('/audio/')) {
        assert.equal(request.headers.authorization, `Bearer ${sentinels.token}`);
        response.setHeader('Content-Type', 'audio/wav');
        response.end('RIFF invented audio fixture');
        return;
      }
      if (request.url.startsWith('/api/')) {
        if (request.url.startsWith('/api/broken/')) {
          request.socket.destroy();
          return;
        }
        response.statusCode = 502;
        response.statusMessage = sentinels.exception;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    upstream.on('upgrade', (request, socket, head) => {
      upstreamSockets.handleUpgrade(request, socket, head, client => upstreamSockets.emit('connection', client));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    upstreamSockets.on('connection', socket => {
      socket.on('message', raw => {
        for (const frame of raw.toString().split('\x1e').filter(Boolean)) {
          const message = JSON.parse(frame);
          if (message.protocol) socket.send('{}\x1e');
          if (message.target === 'SendMessage') {
            const send = payload => socket.send(`${JSON.stringify({
              type: 1, target: 'ReceiveMessage', arguments: [payload],
            })}\x1e`);
            send({ $type: 'recordingRequest', enabled: true, sessionId: sentinels.session });
            send({
              $type: 'replyChunk', text: sentinels.reply,
              audioUrl: `${upstreamUrl}/audio/${sentinels.filename}.wav?token=${sentinels.query}`,
              thinkingSpeechUrl: path.join(scratch, `${sentinels.exception}\n\r\t\x1b[31m.wav`),
            });
          }
        }
      });
    });

    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const relayPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    const relay = spawn('dotnet', [relayDll, '--listen', relayUrl, '--remote', upstreamUrl], {
      cwd: repoRoot,
      env: {
        ...process.env, PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN: sentinels.token,
        PSFN_VOXTA_RELAY_AUDIO_FOLDER: audioFolder, ASPNETCORE_ENVIRONMENT: 'Production',
        Logging__LogLevel__Default: level,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    relay.stdout.on('data', data => { output += data.toString(); });
    relay.stderr.on('data', data => { output += data.toString(); });
    let socket;
    try {
      await waitFor(async () => {
        if (relay.exitCode !== null) throw new Error('Relay exited before listening');
        try { return (await fetch(relayUrl)).status === 200; } catch { return false; }
      });
      assert.equal((await fetch(`${relayUrl}/api/${sentinels.filename}?access_token=${sentinels.query}`)).status, 502);
      assert.equal((await fetch(`${relayUrl}/api/broken/${sentinels.filename}`)).status, 500);
      assert.equal((await fetch(relayUrl, { headers: { Origin: 'https://attacker.example.test' } })).status, 403);
      const negotiation = await fetch(`${relayUrl}/hub/negotiate?negotiateVersion=1`, { method: 'POST' });
      const { connectionToken } = await negotiation.json();
      socket = new WebSocket(`ws://127.0.0.1:${relayPort}/hub?id=${connectionToken}&private=${sentinels.connection}`);
      const frames = [];
      socket.on('message', raw => {
        for (const frame of raw.toString().split('\x1e').filter(Boolean)) frames.push(JSON.parse(frame));
      });
      await once(socket, 'open');
      socket.send('{"protocol":"json","version":1}\x1e');
      await waitFor(() => frames.some(frame => Object.keys(frame).length === 0));
      socket.send(`${JSON.stringify({
        type: 1, target: 'SendMessage', invocationId: 'auth', arguments: [{
          $type: 'authenticate', text: sentinels.transcript, capabilities: { audioFolder },
        }],
      })}\x1e`);
      await waitFor(() => frames.some(frame => frame.arguments?.[0]?.$type === 'replyChunk'));
      const reply = frames.find(frame => frame.arguments?.[0]?.$type === 'replyChunk').arguments[0];
      assert.equal(reply.text, sentinels.reply, 'Privacy logging must preserve the reply transport');
      assert.equal(fs.readFileSync(reply.audioUrl, 'utf8'), 'RIFF invented audio fixture');
      socket.close();
      await once(socket, 'close');
      await waitFor(() => output.includes('Unregistered') || output.includes('client.unregistered'));
    } finally {
      socket?.terminate();
      relay.kill('SIGTERM');
      await once(relay, 'exit');
      for (const client of upstreamSockets.clients) client.terminate();
      await new Promise(resolve => upstreamSockets.close(resolve));
      await new Promise(resolve => upstream.close(resolve));
    }

    // Check the actual process streams, including framework and error output.
    for (const [kind, sentinel] of Object.entries(sentinels)) {
      assert.equal(output.includes(sentinel), false, `${kind} sentinel escaped the logging boundary`);
    }
    assert.doesNotMatch(output, /[\r\t\x00-\x09\x0b-\x1f\x7f]/, 'Log entries cannot contain raw control characters');
    const entries = output.trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['relay.starting', 'client.registered', 'audio.downloaded', 'audio.localization_failed', 'request.failed', 'client.unregistered']) {
      assert.ok(entries.some(entry => entry.event === event), `Missing operational event: ${event}`);
    }
    const download = entries.find(entry => entry.event === 'audio.downloaded');
    assert.equal(download.bytes, Buffer.byteLength('RIFF invented audio fixture'));
    assert.ok(entries.some(entry => entry.event === 'audio.localization_failed' && entry.level === 'Error'));
    const connected = entries.find(entry => entry.event === 'session.connected');
    assert.match(connected.correlation, /^[a-f0-9]{32}$/);
    assert.ok(entries.some(entry => entry.event === 'client.unregistered' && entry.correlation === connected.correlation));
    for (const status of [200, 403, 500, 502]) {
      assert.ok(entries.some(entry => entry.event === 'request.completed' && entry.status === status
        && typeof entry.elapsedMs === 'number'), `Missing request status/timing: ${status}`);
    }
  });
}

test('startup failures cannot print raw arguments, paths or exception details', () => {
  const result = spawnSync('dotnet', [relayDll, `${sentinels.exception}\n\r\t\x1b[31m`], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const entry = JSON.parse(result.stderr);
  assert.equal(entry.event, 'relay.failed');
  assert.equal(entry.level, 'Error');
  assert.equal(result.stderr.includes(sentinels.exception), false);
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for relay privacy test traffic');
}
