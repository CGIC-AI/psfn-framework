import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const relayDll = 'apps/satellite-hub/relay/psfn-voxta-relay/bin/Debug/net8.0/PsfnVoxtaRelay.dll';
const token = randomBytes(32).toString('hex');

test('local Voxta relay authenticates REST requests to the actual Hub', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voxta-relay-auth-'));
  const { RealtimeHubServer } = await import('../dist/ts/hub/server.js');
  const hub = new RealtimeHubServer({
    textOnlyMode: true, bindHost: '127.0.0.1', port: 0, deepgramApiKey: null,
    elevenlabsApiKey: null, elevenlabsVoiceId: null, elevenlabsModelId: 'test',
    artifactsRoot: path.join(scratch, 'artifacts'),
    access: { developerMode: false, allowedOrigins: [], voxtaToken: token },
    psfn: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test', channelType: 'satellite.endpoint',
      satelliteClaim: { namespace: 'satellite.endpoint', type: 'voxta-avatar', channelType: 'satellite.endpoint',
        satelliteId: 'voxta', endpointId: 'voxta', displayName: 'Voxta', endpointClass: 'avatar',
        locationMode: 'static', capabilityProfile: 'voxta-avatar', telemetry: { mode: 'disabled', categories: [] } },
      voiceReplyDeadlineMs: 8000, voiceAttemptTimeoutMs: 6000, textReplyDeadlineMs: 80000, textAttemptTimeoutMs: 75000 },
    companion: null, homeAssistant: null, control: null, deviceRegistry: null,
    eidoversePlaceMap: null, location: null, sessionTtlSeconds: 60,
    voxta: { enabled: true, satelliteId: 'voxta', satelliteName: 'Voxta', sessionId: null, chatId: null,
      assistantId: 'assistant', assistantName: 'Assistant', userId: 'user', userName: 'User',
      appLabel: 'Test', clientVersion: '1', publicBaseUrl: null, audioFolder: null,
      sttStreamEnabled: false, visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
  }, {
    // The external model/TTS boundary is deterministic; all transport,
    // authorization, filesystem and relay behavior is the shipped runtime.
    agent: { async *streamReply() { yield 'Authenticated relay reply'; return 'Authenticated relay reply'; }, async close() {} },
    voxtaTts: { async synthesizeWav() { return Buffer.from('RIFF invented audio fixture'); } },
  });
  await hub.start();
  const hubPort = hub.address().port;
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const relayPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const relay = spawn('dotnet', [relayDll, '--listen', `http://127.0.0.1:${relayPort}`, '--remote', `http://127.0.0.1:${hubPort}`], {
    cwd: repoRoot,
    env: { ...process.env, PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN: token,
      PSFN_VOXTA_RELAY_AUDIO_FOLDER: path.join(scratch, 'audio'), ASPNETCORE_ENVIRONMENT: 'Production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.resume();
  relay.stderr.resume();
  let socket;
  try {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (relay.exitCode !== null) throw new Error('Relay exited before listening');
      try {
        const response = await fetch(`http://127.0.0.1:${relayPort}/`);
        if (response.status === 200) { started = true; break; }
      } catch { /* The process has not bound its socket yet. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(started, true);
    const route = '/api/configurations/unknown/services/TextToSpeech';
    assert.equal((await fetch(`http://127.0.0.1:${hubPort}${route}`, {
      method: 'PUT', body: '{"enabled":false}', headers: { 'Content-Type': 'application/json' },
    })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${relayPort}${route}`, {
      method: 'PUT', body: '{"enabled":false}', headers: { 'Content-Type': 'application/json' },
    })).status, 404, 'Relay credential reaches Hub auth before unknown-resource handling');
    assert.equal((await fetch(`http://127.0.0.1:${relayPort}${route}`, {
      method: 'PUT', body: '{"enabled":false}', headers: { Origin: 'https://attacker.example.test', 'Content-Type': 'application/json' },
    })).status, 403);
    const negotiation = await fetch(`http://127.0.0.1:${relayPort}/hub/negotiate?negotiateVersion=1`, { method: 'POST' });
    const { connectionToken } = await negotiation.json();
    socket = new WebSocket(`ws://127.0.0.1:${relayPort}/hub?id=${connectionToken}`);
    const frames = [];
    socket.on('message', raw => {
      for (const frame of raw.toString().split('\x1e').filter(Boolean)) {
        const parsed = JSON.parse(frame);
        frames.push(parsed.arguments?.[0] ?? parsed);
      }
    });
    await once(socket, 'open');
    const send = (id, payload) => socket.send(`${JSON.stringify({ type: 1, target: 'SendMessage', invocationId: id, arguments: [payload] })}\x1e`);
    socket.send(`${JSON.stringify({ protocol: 'json', version: 1 })}\x1e`);
    send('auth', { $type: 'authenticate', capabilities: {} });
    send('start', { $type: 'startChat' });
    await waitFor(() => frames.some(frame => frame.$type === 'chatStarted'));
    const sessionId = frames.find(frame => frame.$type === 'chatStarted').sessionId;
    send('send', { $type: 'send', sessionId, text: 'test relay' });
    await waitFor(() => frames.some(frame => frame.$type === 'replyEnd'));
    const chunk = frames.find(frame => frame.$type === 'replyChunk');
    assert.equal(chunk.text, 'Authenticated relay reply');
    assert.equal(fs.readFileSync(chunk.audioUrl, 'utf8'), 'RIFF invented audio fixture');
  } finally {
    socket?.terminate();
    relay.kill('SIGTERM');
    await once(relay, 'exit');
    await hub.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('credential-holding Voxta relay refuses a wildcard listener', () => {
  const result = spawnSync('dotnet', [relayDll, '--listen', 'http://0.0.0.0:8789', '--remote', 'http://127.0.0.1:1'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).event, 'relay.failed');
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for an authenticated relay response');
}
