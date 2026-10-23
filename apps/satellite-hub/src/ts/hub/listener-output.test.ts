import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { HubConfig } from "../shared/env.js";
import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import { createHubDeviceRegistryAuthority } from "./device-registry.js";
import { RealtimeHubServer } from "./server.js";
import { HubResources } from "./transport-resources.js";

const credential = "listener-budget-test-secret";
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "expected transport outcome within one second");
}

function runtime(root: string): HubConfig {
  return {
    textOnlyMode: true, bindHost: "127.0.0.1", port: 0, deepgramApiKey: null,
    elevenlabsApiKey: null, elevenlabsVoiceId: null, elevenlabsModelId: "test",
    artifactsRoot: path.join(root, "artifacts"), companion: null, homeAssistant: null, control: null,
    eidoversePlaceMap: null, location: null, sessionTtlSeconds: 60,
    access: { developerMode: false, allowedOrigins: [] },
    limits: { maxBufferedBytes: 1024, maxAuthenticatedConnections: 2, maxUnauthenticatedConnections: 1, providerTimeoutMs: 1000, authenticationTimeoutMs: 3000 },
    psfn: { baseUrl: "http://127.0.0.1:1/v1", model: "test", channelType: "satellite.endpoint",
      voiceReplyDeadlineMs: 8000, voiceAttemptTimeoutMs: 6000, textReplyDeadlineMs: 8000, textAttemptTimeoutMs: 6000,
      deviceAssertionIssuer: createHubDeviceAssertionIssuer({ issuer: "test", kid: "test", audience: "https://fleet.example.test",
        privateKeyPem: createPrivateKey({ key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN", "base64"),
          format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }).toString(), ttlSeconds: 30 }),
      satelliteClaim: { namespace: "satellite.endpoint", type: "text-only", channelType: "satellite.endpoint",
        capabilityProfile: "text-only", satelliteId: "hub", endpointId: "hub", displayName: "Hub", endpointClass: "text",
        locationMode: "static", telemetry: { mode: "disabled", categories: [] } } },
    deviceRegistry: createHubDeviceRegistryAuthority(() => ({ schemaVersion: 1, devices: [{
      deviceId: "test-device", deviceName: "Test device", satelliteId: "test-device", satelliteName: "Test", endpointId: "test-device",
      claimType: "room-satellite", credentialSha256: createHash("sha256").update(credential).digest("hex"),
      enrollmentVersion: 1, enrollmentAssurance: "device_credential", enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111", placeId: "test", homeAssistantEntityIds: [],
      maxCapabilities: { input: ["text", "microphone_pcm"], output: ["text", "streamed_audio"], control: ["interrupt"], safety: ["local_only"] },
    }] })),
    voxta: { enabled: true, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null, chatId: null,
      assistantId: "assistant", assistantName: "Assistant", userId: "user", userName: "User", appLabel: "Test", clientVersion: "1",
      publicBaseUrl: null, audioFolder: null, sttStreamEnabled: true, visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
  };
}

for (const surface of ["preauth", "realtime", "voxta", "audio"] as const) {
  test(`${surface} non-reading real peer cannot fill unbudgeted automatic pong output`, async t => {
    const peers: WebSocket[] = [];
    const emit = WebSocketServer.prototype.emit;
    t.mock.method(WebSocketServer.prototype, "emit", function(this: WebSocketServer, event: string | symbol, ...args: unknown[]) {
      if (event === "connection") peers.push(args[0] as WebSocket);
      return emit.call(this, event, ...args);
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-listener-output-"));
    const config = runtime(root);
    const resources = new HubResources({ ...config.limits, maxBufferedBytes: 16384 });
    let providerCalls = 0;
    const server = new RealtimeHubServer(config, {
      resources,
      agent: { async *streamReply() { providerCalls++; yield "recovered"; return "recovered"; }, async close() {} },
      voxtaTts: null, voxtaStt: { async transcribePcm() { providerCalls++; return { text: "unused" }; } },
      realtimeStt: async () => { providerCalls++; return { text: "unused", provider: "test", latencyMs: 0 }; },
    });
    const clients: WebSocket[] = [];
    await server.start();
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const open = async (route: string): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${route}`, {
        headers: route === "/" ? {} : { Authorization: `Bearer ${credential}` },
      });
      clients.push(socket);
      const frames: Record<string, unknown>[] = [];
      socket.on("message", raw => { for (const text of raw.toString().split("\x1e").filter(Boolean)) {
        const frame = JSON.parse(text) as { arguments?: Record<string, unknown>[] };
        frames.push(frame.arguments?.[0] ?? frame);
      } });
      await once(socket, "open"); return { socket, frames };
    };
    const signalr = async () => {
      const client = await open("/hub");
      for (const $type of ["authenticate", "startChat"]) client.socket.send(JSON.stringify({ type: 1, target: "SendMessage", arguments: [{ $type }] }));
      await until(() => client.frames.some(frame => frame.$type === "chatStarted"));
      return client;
    };
    try {
      let route = surface === "voxta" ? "/hub" : "/";
      if (surface === "audio") {
        const owner = await signalr();
        route = `/ws/audio/input/stream?sessionId=${owner.frames.find(frame => frame.$type === "chatStarted")!.sessionId}`;
      }
      // Bootstrap the audio owner before creating the independently bounded
      // target socket; output limits are fixed when that socket is accepted.
      resources.limits.maxBufferedBytes = 1024;
      const client = await open(route);
      if (surface === "realtime") {
        client.socket.send(JSON.stringify({ type: "hello", deviceId: "test-device", credential }));
        await until(() => client.frames.some(frame => frame.type === "hello.ack"));
      }
      const peer = peers.at(-1)!;
      const framesBefore = [...client.frames];
      client.socket.pause();
      let peak = 0;
      const pong = peer.pong.bind(peer);
      t.mock.method(peer, "pong", (data: Buffer, mask: boolean | undefined, callback?: (error?: Error) => void) => {
        pong(data, mask, callback);
        peak = Math.max(peak, peer.bufferedAmount);
      });
      // Real ws writes and TCP backpressure, with no mocked queue or callbacks.
      for (let batch = 0; batch < 100 && peer.readyState === WebSocket.OPEN; batch++) {
        for (let i = 0; i < 1000 && client.socket.readyState === WebSocket.OPEN; i++) client.socket.ping(Buffer.alloc(125));
        await delay(1);
      }
      await delay(20);
      assert.ok(peak <= 1024, `native pong output retained ${peak} bytes with a 1024-byte cap`);
      assert.notEqual(peer.readyState, WebSocket.OPEN, "ping flood must terminate its socket");
      assert.equal(providerCalls, 0);
      assert.deepEqual(client.frames, framesBefore, "pings cannot produce application frames");
      assert.equal(fs.existsSync(config.artifactsRoot), false);
      client.socket.resume(); client.socket.terminate();
      await until(() => peer.readyState === WebSocket.CLOSED);
      const recovered = await open(route);
      const pongs = once(recovered.socket, "pong"); recovered.socket.ping("fresh");
      assert.equal((await pongs)[0].toString(), "fresh");
      assert.equal(providerCalls, 0);
    } finally {
      for (const socket of clients) { socket.resume(); socket.terminate(); }
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("ordinary listener closes finalize accepted audio once and shutdown bounds an unread close handshake", async t => {
  const peers: WebSocket[] = [];
  const emit = WebSocketServer.prototype.emit;
  t.mock.method(WebSocketServer.prototype, "emit", function(this: WebSocketServer, event: string | symbol, ...args: unknown[]) {
    if (event === "connection") peers.push(args[0] as WebSocket);
    return emit.call(this, event, ...args);
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-listener-lifecycle-"));
  const config = runtime(root);
  const resources = new HubResources({ ...config.limits, maxBufferedBytes: 16384, authenticationTimeoutMs: 500 });
  const transcribed: Buffer[] = [];
  let modelCalls = 0;
  const server = new RealtimeHubServer(config, {
    resources,
    agent: { async *streamReply() { modelCalls++; yield "unexpected"; return "unexpected"; }, async close() {} },
    voxtaTts: null,
    voxtaStt: { async transcribePcm(input) { transcribed.push(Buffer.from(input.pcm)); return { text: "accepted audio" }; } },
  });
  const clients: WebSocket[] = [];
  const frames: Record<string, unknown>[] = [];
  let shutdownStarted = false;
  await server.start();
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const open = async (route: string): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${route}`, { headers: { Authorization: `Bearer ${credential}` } });
    clients.push(socket);
    socket.on("message", raw => {
      for (const text of raw.toString().split("\x1e").filter(Boolean)) {
        const frame = JSON.parse(text) as { arguments?: Record<string, unknown>[] };
        frames.push(frame.arguments?.[0] ?? frame);
      }
    });
    await once(socket, "open"); return socket;
  };
  try {
    const realtime = await open("/");
    realtime.send(JSON.stringify({ type: "hello", deviceId: "test-device", credential }));
    await until(() => frames.some(frame => frame.type === "hello.ack"));
    const pong = once(realtime, "pong"); realtime.ping("ordinary");
    assert.equal((await pong)[0].toString(), "ordinary");
    const closed = once(realtime, "close"); realtime.close(1000, "done");
    const [code, reason] = await closed;
    assert.equal(code, 1000); assert.equal(reason.toString(), "done");
    await until(() => peers[0]!.readyState === WebSocket.CLOSED);

    const voxta = await open("/hub");
    voxta.send('{"protocol":"json","version":1}\x1e');
    await until(() => frames.some(frame => Object.keys(frame).length === 0));
    for (const $type of ["authenticate", "startChat"]) {
      voxta.send(JSON.stringify({ type: 1, target: "SendMessage", arguments: [{ $type }] }));
    }
    await until(() => frames.some(frame => frame.$type === "chatStarted"));
    const audioRoute = `/ws/audio/input/stream?sessionId=${frames.find(frame => frame.$type === "chatStarted")!.sessionId}`;
    const audio = await open(audioRoute);
    audio.send(JSON.stringify({ sampleRate: 16000, channels: 1, bitsPerSample: 16, bufferMilliseconds: 30, contentType: "audio/pcm" }));
    audio.send(Buffer.from([1, 0, 2, 0]));
    const audioClosed = once(audio, "close"); audio.close(1000); await audioClosed;
    await until(() => frames.some(frame => frame.$type === "speechRecognitionEnd"));
    assert.deepEqual(transcribed, [Buffer.from([1, 0, 2, 0])]);

    const stalled = await open(audioRoute);
    stalled.pause();
    const voxtaClosed = once(voxta, "close");
    const started = Date.now();
    shutdownStarted = true;
    // The shared shutdown deadline may report the handshake deadline itself.
    await server.close().catch(error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.every(cause => cause instanceof Error && cause.name === "TimeoutError"));
    });
    await until(() => peers.every(peer => peer.readyState === WebSocket.CLOSED));
    assert.ok(Date.now() - started < 1500, "shutdown remains bounded with an unread close frame");
    assert.equal((await voxtaClosed)[0], 1001);
    assert.equal(transcribed.length, 1, "shutdown cannot submit an incomplete microphone stream");
    assert.equal(modelCalls, 0);
    assert.equal(resources.admitSocket(true), null, "shutdown permanently stops connection admission");
  } finally {
    for (const socket of clients) { socket.resume(); socket.terminate(); }
    if (!shutdownStarted) await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
