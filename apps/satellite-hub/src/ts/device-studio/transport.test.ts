import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import type { ClientToHubMessage, HubToClientMessage } from "../shared/protocol.js";
import { fixtureMotionDisplayProfile, fixtureScreenOnlyProfile } from "./fixtures.js";
import {
  buildDeviceStudioHelloPayload,
  DeviceStudioHubClient,
  inferSatelliteCapabilities,
  parseHubMessage,
  type DeviceStudioLifecycleEvent,
  type DeviceStudioTransportEventMap,
  type DeviceStudioWebSocketLike,
} from "./transport.js";

test("hello payload is stable and inferred from profile capabilities", () => {
  const hello = buildDeviceStudioHelloPayload({
    profile: fixtureMotionDisplayProfile,
    capabilities: {
      output: ["local_file_audio"],
      safety: ["confirmation_required"],
    },
  });

  assert.equal(hello.type, "hello");
  assert.equal(hello.deviceId, "device-studio-fixture-motion-display");
  assert.equal(hello.deviceName, "Device Studio Fixture Motion Display Device");
  assert.equal(hello.sessionId, "device-studio:fixture-motion-display");
  assert.equal(hello.satelliteId, hello.deviceId);
  assert.equal(hello.satelliteName, hello.deviceName);

  assert.deepEqual(hello.capabilities?.input, [
    "text",
    "wake_event",
    "microphone_pcm",
    "final_transcript",
  ]);
  assert.deepEqual(hello.capabilities?.output, [
    "text",
    "subtitle",
    "action",
    "expression",
    "streamed_audio",
    "servo",
    "gaze",
    "animation",
    "local_file_audio",
  ]);
  assert.deepEqual(hello.capabilities?.control, ["interrupt", "presence", "session_attach"]);
  assert.deepEqual(hello.capabilities?.safety, ["local_only", "confirmation_required"]);

  assert.deepEqual(inferSatelliteCapabilities(fixtureScreenOnlyProfile).output, [
    "text",
    "subtitle",
    "action",
    "expression",
  ]);
});

test("hub message parser accepts known protocol messages and rejects malformed payloads", () => {
  const parsed = parseHubMessage(JSON.stringify({
    type: "message",
    data: {
      role: "assistant",
      content: "hello",
      live: true,
    },
  }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.message.type, "message");
    assert.equal(parsed.message.data.role, "assistant");
  }

  const invalidJson = parseHubMessage("{");
  assert.equal(invalidJson.ok, false);
  if (!invalidJson.ok) {
    assert.match(invalidJson.error, /^Invalid hub JSON:/);
    assert.equal(invalidJson.payload, "{");
  }

  const missingContent = parseHubMessage({
    type: "message",
    data: {
      role: "assistant",
    },
  });
  assert.equal(missingContent.ok, false);
  if (!missingContent.ok) {
    assert.equal(missingContent.error, "message data.content must be a string");
  }

  const unknownType = parseHubMessage({ type: "device-studio.private-extension" });
  assert.equal(unknownType.ok, false);
  if (!unknownType.ok) {
    assert.equal(unknownType.error, "Unsupported hub message type: device-studio.private-extension");
  }
});

test("embodiment MVP stays on existing realtime protocol messages", async () => {
  const candidateExtensionTypes = [
    "embodiment.state",
    "behavior.command",
    "device.input",
  ] as const;

  for (const type of candidateExtensionTypes) {
    const parsed = parseHubMessage({ type });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.error, `Unsupported hub message type: ${type}`);
    }
  }

  const client = new DeviceStudioHubClient({
    mode: "mock",
    profile: fixtureMotionDisplayProfile,
    mock: {
      assistantText: "Existing lifecycle drove the preview.",
      assistantLiveDeltas: ["Existing lifecycle ", "drove the preview."],
    },
    clock: fixedClock("2026-05-11T16:02:00.000Z"),
  });
  const lifecycle: DeviceStudioLifecycleEvent[] = [];
  client.on("lifecycle", (event) => lifecycle.push(event));

  await client.connect();
  const assistantFinal = waitForEvent(
    client,
    "message",
    (event) => event.role === "assistant" && event.final,
  );
  client.sendUserText("preview a happy greeting", { interrupt: false });
  assert.equal((await assistantFinal).content, "Existing lifecycle drove the preview.");

  const wireMessageTypes = client.getLog()
    .filter((entry) => entry.direction === "in" || entry.direction === "out")
    .map((entry) => entry.messageType)
    .filter((type): type is string => typeof type === "string");
  assert.equal(wireMessageTypes.includes("hello"), true);
  assert.equal(wireMessageTypes.includes("user.text"), true);
  assert.equal(wireMessageTypes.includes("message"), true);
  assert.equal(wireMessageTypes.includes("text"), true);
  assert.equal(
    wireMessageTypes.some((type) => candidateExtensionTypes.includes(
      type as (typeof candidateExtensionTypes)[number],
    )),
    false,
  );

  assert.equal(lifecycle.some((event) => event.name === "audio.start"), true);
  assert.equal(lifecycle.some((event) => event.name === "audio.end"), true);
  assert.equal(client.snapshot().session.assistantSpeaking, false);
});

test("live transport sends hello and typed commands over websocket", async () => {
  const server = new WebSocketServer({ port: 0 });
  const received: ClientToHubMessage[] = [];
  const connection = once(server, "connection") as Promise<[WebSocket]>;
  if (!server.address()) {
    await once(server, "listening");
  }
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = new DeviceStudioHubClient({
    mode: "live",
    url,
    profile: fixtureScreenOnlyProfile,
    webSocketFactory: (targetUrl) => new WebSocket(targetUrl) as unknown as DeviceStudioWebSocketLike,
    nowMs: () => 100,
    clock: fixedClock("2026-05-11T16:00:00.000Z"),
  });

  await client.connect();
  const [socket] = await connection;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ClientToHubMessage;
    received.push(message);
    switch (message.type) {
      case "hello": {
        const sessionId = message.sessionId ?? `realtime:${message.deviceId}`;
        const channelId = message.channelId ?? `satellite.endpoint:${sessionId}`;
        const satelliteId = message.satelliteId ?? message.deviceId;
        const satelliteName = message.satelliteName ?? message.deviceName;
        socket.send(JSON.stringify({
          type: "session.ready",
          sessionId,
          channelId,
          deviceId: message.deviceId,
          deviceName: message.deviceName,
          satelliteId,
          audioFormat: "pcm_s16le_16000_mono_in/mp3_44100_out",
        } satisfies HubToClientMessage));
        socket.send(JSON.stringify({
          type: "hello.ack",
          sessionId,
          channelId,
          deviceId: message.deviceId,
          deviceName: message.deviceName,
          satelliteId,
          satelliteName,
          capabilities: message.capabilities ?? {},
        } satisfies HubToClientMessage));
        socket.send(JSON.stringify({ type: "status", data: "call_initialized" } satisfies HubToClientMessage));
        return;
      }
      case "user.text":
        socket.send(JSON.stringify({
          type: "message",
          data: { role: "user", content: message.text, final: true },
        } satisfies HubToClientMessage));
        return;
      case "ping":
        socket.send(JSON.stringify({ type: "pong", sentAt: message.sentAt } satisfies HubToClientMessage));
        return;
      case "interrupt":
        socket.send(JSON.stringify({
          type: "assistant.interrupted",
          sessionId: client.snapshot().session.sessionId ?? "unknown",
        } satisfies HubToClientMessage));
        return;
      default:
        return;
    }
  });

  await client.waitUntilReady();
  assert.equal(client.snapshot().state, "ready");
  assert.equal(client.snapshot().session.sessionId, "device-studio:fixture-screen-only-round");
  assert.equal(received[0]?.type, "hello");

  const audio = waitForEvent(client, "audio", () => true);
  socket.send(JSON.stringify({ type: "audio", data: "AQID" } satisfies HubToClientMessage));
  assert.equal((await audio).estimatedBytes, 3);

  const userEcho = waitForEvent(client, "message", (event) => event.role === "user" && event.final);
  client.sendUserText("  hello hub  ", { interrupt: false });
  assert.equal((await userEcho).content, "hello hub");

  const pong = waitForEvent(client, "pong", () => true);
  client.ping(100);
  assert.equal((await pong).rttMs, 0);

  const interrupted = waitForEvent(client, "lifecycle", (event) => event.name === "assistant.interrupted");
  client.interrupt();
  await interrupted;

  assert.deepEqual(received.map((message) => message.type), ["hello", "user.text", "ping", "interrupt"]);
  assert.deepEqual(received[1], {
    type: "user.text",
    text: "hello hub",
    interrupt: false,
  });
  assert.deepEqual(received[2], { type: "ping", sentAt: 100 });
  assert.deepEqual(received[3], { type: "interrupt" });

  client.disconnect();
  await closeServer(server);
});

test("mock transport emits deterministic handshake and typed turn flow", async () => {
  const client = new DeviceStudioHubClient({
    mode: "mock",
    profile: fixtureMotionDisplayProfile,
    mock: {
      assistantText: "Mock says hello.",
      assistantLiveDeltas: ["Mock says ", "hello."],
    },
    clock: fixedClock("2026-05-11T16:05:00.000Z"),
    nowMs: () => 200,
  });
  const lifecycle: DeviceStudioLifecycleEvent[] = [];
  client.on("lifecycle", (event) => lifecycle.push(event));

  await client.connect();
  assert.equal(client.snapshot().state, "ready");
  assert.equal(client.snapshot().ready, true);
  assert.deepEqual(lifecycle.map((event) => event.name), ["session.ready", "hello.ack", "status"]);
  assert.deepEqual(client.getLog().map((entry) => [entry.direction, entry.kind, entry.source]), [
    ["internal", "transport.connecting", "transport"],
    ["internal", "transport.connected", "mock"],
    ["out", "hub.hello", "transport"],
    ["in", "hub.session.ready", "mock"],
    ["internal", "transport.ready", "mock"],
    ["in", "hub.hello.ack", "mock"],
    ["in", "hub.status", "mock"],
  ]);

  const assistantFinal = waitForEvent(
    client,
    "message",
    (event) => event.role === "assistant" && event.final,
  );
  client.sendUserText("hello mock");
  assert.equal((await assistantFinal).content, "Mock says hello.");

  const messageEvents = client.getLog().filter((entry) => entry.kind === "hub.message");
  assert.equal(messageEvents.length, 4);
  assert.equal(client.getLog().some((entry) => entry.kind === "hub.text" && entry.direction === "in"), true);
  assert.equal(client.snapshot().session.assistantSpeaking, false);
});

test("mock interrupt clears pending assistant flow and emits structured lifecycle", async () => {
  const client = new DeviceStudioHubClient({
    mode: "mock",
    profile: fixtureMotionDisplayProfile,
    mock: {
      stepDelayMs: 5,
      assistantText: "This response should be cancelled.",
      assistantLiveDeltas: ["This response ", "should be cancelled."],
    },
  });

  await client.connect();
  const audioStart = waitForEvent(client, "lifecycle", (event) => event.name === "audio.start");
  client.sendUserText("start a long turn");
  await audioStart;
  assert.equal(client.snapshot().session.assistantSpeaking, true);

  const interrupted = waitForEvent(client, "lifecycle", (event) => event.name === "assistant.interrupted");
  client.interrupt();
  await interrupted;
  assert.equal(client.snapshot().session.assistantSpeaking, false);

  await delay(35);
  const assistantFinals = client.getLog().filter((entry) => {
    if (entry.kind !== "hub.message" || entry.direction !== "in") {
      return false;
    }
    const payload = entry.payload as HubToClientMessage;
    return payload.type === "message" && payload.data.role === "assistant" && payload.data.final === true;
  });
  assert.equal(assistantFinals.length, 0);
  assert.equal(client.getLog().some((entry) => entry.kind === "hub.interrupt" && entry.direction === "out"), true);
});

test("connection state transitions close cleanly", async () => {
  const client = new DeviceStudioHubClient({
    mode: "mock",
    profile: fixtureScreenOnlyProfile,
  });
  const states: string[] = [];
  client.on("state", (event) => states.push(event.current));

  await client.connect();
  client.disconnect();

  assert.deepEqual(states, ["connecting", "connected", "ready", "closed"]);
  assert.equal(client.snapshot().state, "closed");
  assert.equal(client.snapshot().ready, false);
});

function fixedClock(value: string): () => Date {
  return () => new Date(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent<K extends keyof DeviceStudioTransportEventMap>(
  client: DeviceStudioHubClient,
  type: K,
  predicate: (event: DeviceStudioTransportEventMap[K]) => boolean,
  timeoutMs = 1000,
): Promise<DeviceStudioTransportEventMap[K]> {
  return new Promise((resolve, reject) => {
    const unsubscribe = client.on(type, (event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${String(type)} event`));
    }, timeoutMs);
  });
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.close();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
