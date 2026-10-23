import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { CompanionBrowserBridge } from "./companion-browser-bridge.js";
import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import { createHubDeviceRegistryAuthority } from "./device-registry.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import type { PsfnRuntimeConfig } from "../shared/env.js";

const companionId = "11111111-1111-4111-8111-111111111111";
const credential = "invented-browser-device-credential";

async function fixture(handshakeTimeoutMs = 1000) {
  const serverPeers: WebSocket[] = [];
  const gateway = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(gateway, "listening");
  gateway.on("connection", socket => {
    serverPeers.push(socket);
    socket.send(JSON.stringify({ type: "session.ready", capabilities: [] }));
  });
  const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const { privateKey } = generateKeyPairSync("ed25519");
  const runtime: PsfnRuntimeConfig = {
    apiKey: "invented-hub-key", model: "test", baseUrl: "https://gateway.example.test", channelType: "satellite.endpoint",
    satelliteClaim: normalizeSatelliteClaimConfig(), voiceReplyDeadlineMs: 1000, voiceAttemptTimeoutMs: 1000,
    textReplyDeadlineMs: 1000, textAttemptTimeoutMs: 1000,
    deviceAssertionIssuer: createHubDeviceAssertionIssuer({ issuer: "invented-hub", kid: "test", audience: "https://gateway.example.test",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ttlSeconds: 60 }),
  };
  const registry = createHubDeviceRegistryAuthority(() => ({ schemaVersion: 1, devices: [{
    deviceId: "browser", deviceName: "Browser", satelliteId: "browser", satelliteName: "Browser", endpointId: "browser",
    claimType: "browser", credentialSha256: createHash("sha256").update(credential).digest("hex"), enrollmentVersion: 1,
    enrollmentAssurance: "device_credential", enrollmentStatus: "active", companionId,
    maxCapabilities: { input: ["text"], output: ["text"], control: [], safety: [] }, homeAssistantEntityIds: [],
  }] }));
  const control = { hold: false, native: 0, fail: false, sent: [] as Array<string | Buffer>, callbacks: [] as Array<(error?: Error) => void> };
  const upstreams: WebSocket[] = [];
  const bridge = new CompanionBrowserBridge({ canonicalOrigin: "https://fleet.example.test", gatewayOrigin: "https://gateway.example.test",
    guestMode: "explicit", deviceCredentials: [credential], maxFrameBytes: 1024, maxBufferedBytes: 1024,
    maxConnections: 1, handshakeTimeoutMs, enrollmentPollMs: 10000 }, runtime, registry, null,
  (_url, options) => {
    const socket = new WebSocket(gatewayUrl, options); upstreams.push(socket);
    const native = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount")!.get!.bind(socket) as () => number;
    Object.defineProperty(socket, "bufferedAmount", { get: () => Math.max(control.native, native()) });
    const send = socket.send.bind(socket);
    socket.send = ((data: string | Buffer, callback: (error?: Error) => void) => {
      control.sent.push(data);
      send(data, error => {
        if (control.fail) callback(new Error("PRIVATE gateway failure"));
        else if (control.hold) control.callbacks.push(callback);
        else callback(error);
      });
    }) as WebSocket["send"];
    return socket;
  });
  const listener = http.createServer();
  listener.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const clients: WebSocket[] = [];
  const connect = async () => {
    const browser = new WebSocket(`ws://127.0.0.1:${(listener.address() as AddressInfo).port}/companion-ui/companions/${companionId}/ws`,
      { headers: { Host: "fleet.example.test", Origin: "https://fleet.example.test" } });
    clients.push(browser);
    const ready = once(browser, "message");
    await once(browser, "open"); await ready;
    return browser;
  };
  return { control, upstreams, serverPeers, connect, bridge, close: async () => {
    await bridge.close();
    for (const socket of [...clients, ...upstreams, ...serverPeers]) socket.terminate();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => listener.close(() => resolve()))]);
  } };
}

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 1)); }
}
for (const mode of ["bytes", "frames", "native", "callback", "timeout"]) {
  test(`companion browser relay ${mode} overflow terminates both peers and a new attachment recovers`, async () => {
    const f = await fixture(mode === "timeout" ? 50 : 1000);
    try {
      const browser = await f.connect();
      f.serverPeers[0]!.pause(); f.control.hold = true;
      const closed = once(browser, "close");
      if (mode === "native") f.control.native = 1024;
      if (mode === "callback") f.control.fail = true;
      const frame = mode === "bytes" ? JSON.stringify({ type: "user.text", text: "x".repeat(994) }) : '{"type":"ping"}';
      assert.ok(Buffer.byteLength(frame) <= 1024);
      const expected = mode === "native" ? 0 : mode === "frames" ? 32 : 1;
      for (let i = 0; i < (mode === "frames" ? 33 : mode === "bytes" ? 2 : 1); i++) browser.send(frame);
      await closed;
      assert.equal(f.control.sent.length, expected);
      if (mode === "bytes") assert.equal(Buffer.byteLength(f.control.sent[0]!), 1024);
      await waitFor(() => f.upstreams[0]!.readyState === WebSocket.CLOSED);
      for (const callback of f.control.callbacks) { callback(); callback(); }
      f.control.native = 0; f.control.hold = false; f.control.fail = false;
      const recovered = await f.connect();
      const received = once(f.serverPeers[1]!, "message"); recovered.send('{"type":"ping"}');
      assert.equal(String((await received)[0]), '{"type":"ping"}');
    } finally { await f.close(); }
  });
}

test("companion browser downstream flood is bounded and shutdown settles callback-pending relay writes", async () => {
  const f = await fixture();
  try {
    const browser = await f.connect(); browser.pause();
    for (let i = 0; i < 1000; i++) f.serverPeers[0]!.send('{"type":"event"}');
    await waitFor(() => f.upstreams[0]!.readyState === WebSocket.CLOSED);
    browser.resume();
    const recovered = await f.connect();
    f.control.hold = true; recovered.send('{"type":"ping"}');
    await waitFor(() => f.control.callbacks.length === 1);
    await f.bridge.close();
    await waitFor(() => f.upstreams[1]!.readyState === WebSocket.CLOSED);
    for (const callback of f.control.callbacks) { callback(); callback(new Error("PRIVATE stale completion")); }
  } finally { await f.close(); }
});
