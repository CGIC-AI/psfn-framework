import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { RealtimeHubServer } from "./server.js";
import type { HubConfig } from "../shared/env.js";
import type { HubToClientMessage } from "../shared/protocol.js";
import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import type { PsfnChannelContext } from "./embodied-session.js";
import {
  createHubDeviceRegistryAuthority,
  type HubDeviceIdentity,
  type HubDeviceRegistry,
  type HubDeviceRegistryAuthority,
} from "./device-registry.js";

const credential = "office-satellite-secret";
const DEVICE_ASSERTION_ISSUER = createHubDeviceAssertionIssuer({
  issuer: "psfn-satellite-hub",
  kid: "hub-test",
  audience: "https://fleet.example.test",
  privateKeyPem: createPrivateKey({
    key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN", "base64"),
    format: "der",
    type: "pkcs8",
  }).export({ format: "pem", type: "pkcs8" }).toString(),
  ttlSeconds: 30,
});

test("realtime hub requires registry authentication before accepting messages", async () => {
  const server = new RealtimeHubServer(config(), { agent: agent() });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve) => socket.once("open", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(messages.length, 0, "authenticated deployments must not emit pre-auth session metadata");
  socket.send(JSON.stringify({ type: "user.text", text: "bypass" }));
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  assert.equal(messages.at(-1)?.type, "error-event");
  await server.close();
});

test("authenticated hello uses registry-owned identity and bounded capabilities", async () => {
  const server = new RealtimeHubServer(config(), { agent: agent() });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({
    type: "hello",
    deviceId: "office-device",
    deviceName: "Spoofed Name",
    satelliteId: "spoofed-room",
    credential,
    capabilities: { input: ["text"], output: ["text"], control: [], safety: [] },
  }));
  await waitFor(() => messages.some((message) => message.type === "hello.ack"));
  const ack = messages.find((message) => message.type === "hello.ack");
  assert.ok(ack && ack.type === "hello.ack");
  const ready = messages.find((message) => message.type === "session.ready");
  assert.ok(ready && ready.type === "session.ready");
  assert.equal(ack.deviceName, "Office Device");
  assert.equal(ack.satelliteId, "office");
  assert.deepEqual(ack.capabilities.control, []);
  assert.deepEqual(ack.capabilities.safety, ["local_only"]);
  assert.deepEqual(ready.capabilities, ack.capabilities);
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await server.close();
});

test("authenticated spoken replies advertise and emit one bracketed audio stream", async () => {
  const tts = new RecordingTts(["first-audio", "second-audio"]);
  const server = new RealtimeHubServer(
    config({ streamingAudio: true }),
    { agent: fixedReplyAgent("Spoken reply."), realtimeTts: tts },
  );
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>(resolve => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: { input: ["text"], output: ["text", "streamed_audio"], control: [], safety: [] },
    }));
    await waitFor(() => messages.some(message => message.type === "hello.ack"));
    const ready = messages.find(message => message.type === "session.ready");
    assert.ok(ready && ready.type === "session.ready");
    assert.deepEqual(ready.capabilities.output, ["text", "streamed_audio"]);

    socket.send(JSON.stringify({ type: "user.text", text: "speak" }));
    await waitFor(() => messages.some(message => message.type === "text" && message.data === "audio-end"));

    assert.deepEqual(
      messages.flatMap(message => {
        if (message.type === "text" && (message.data === "audio-init" || message.data === "audio-end")) {
          return [message.data];
        }
        if (message.type === "audio") {
          return [Buffer.from(message.data, "base64").toString("utf8")];
        }
        return [];
      }),
      ["audio-init", "first-audio", "second-audio", "audio-end"],
    );
    assert.deepEqual(tts.calls, ["Spoken reply."]);
  } finally {
    socket.close();
    await new Promise<void>(resolve => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("authenticated spoken replies fail closed for an audio-incapable client", async () => {
  const tts = new RecordingTts(["must-not-send"]);
  const server = new RealtimeHubServer(
    config({ streamingAudio: true }),
    { agent: fixedReplyAgent("Text only."), realtimeTts: tts },
  );
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>(resolve => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: { input: ["text"], output: ["text"], control: [], safety: [] },
    }));
    await waitFor(() => messages.some(message => message.type === "hello.ack"));
    const ready = messages.find(message => message.type === "session.ready");
    assert.ok(ready && ready.type === "session.ready");
    assert.deepEqual(ready.capabilities.output, ["text"]);

    socket.send(JSON.stringify({ type: "user.text", text: "reply in text" }));
    await waitFor(() => finalAssistantMessages(messages).includes("Text only."));

    assert.equal(messages.some(message => message.type === "audio"), false);
    assert.equal(messages.some(
      message => message.type === "text" && (message.data === "audio-init" || message.data === "audio-end"),
    ), false);
    assert.deepEqual(tts.calls, []);
  } finally {
    socket.close();
    await new Promise<void>(resolve => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("session readiness removes streamed audio when spoken-reply TTS is unavailable", async () => {
  const runtimeConfig = config({ streamingAudio: true });
  runtimeConfig.elevenlabsApiKey = null;
  runtimeConfig.elevenlabsVoiceId = null;
  const tts = new RecordingTts(["must-not-send"]);
  const server = new RealtimeHubServer(
    runtimeConfig,
    { agent: fixedReplyAgent("Unavailable audio."), realtimeTts: tts },
  );
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>(resolve => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: { input: ["text"], output: ["text", "streamed_audio"], control: [], safety: [] },
    }));
    await waitFor(() => messages.some(message => message.type === "hello.ack"));
    const ready = messages.find(message => message.type === "session.ready");
    const ack = messages.find(message => message.type === "hello.ack");
    assert.ok(ready && ready.type === "session.ready");
    assert.ok(ack && ack.type === "hello.ack");
    assert.deepEqual(ready.capabilities.output, ["text"]);
    assert.deepEqual(ack.capabilities.output, ["text"]);

    socket.send(JSON.stringify({ type: "user.text", text: "do not synthesize" }));
    await waitFor(() => finalAssistantMessages(messages).includes("Unavailable audio."));
    assert.equal(messages.some(message => message.type === "audio"), false);
    assert.deepEqual(tts.calls, []);
  } finally {
    socket.close();
    await new Promise<void>(resolve => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("authenticated hello rejects browser-authored place, companion, contact, or human authority", async () => {
  for (const forbidden of [
    { placeId: "kitchen" },
    { companionId: "22222222-2222-4222-8222-222222222222" },
    { contactId: "owner" },
    { humanPrincipalId: "browser-user" },
  ]) {
    const server = new RealtimeHubServer(config(), { agent: agent() });
    await server.start();
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const messages: HubToClientMessage[] = [];
    socket.on("message", raw => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello", deviceId: "office-device", deviceName: "Office Device", credential, ...forbidden,
    }));
    await new Promise<void>(resolve => socket.once("close", () => resolve()));
    assert.equal(messages.some(message => message.type === "hello.ack"), false);
    assert.equal(messages.at(-1)?.type, "error-event");
    await server.close();
  }
});

test("authenticated user.text forwards an explicit text reply mode", async () => {
  let capturedMode: Parameters<FrameworkAgentAdapter["streamReply"]>[0]["inputMode"] | undefined;
  const replyAgent: FrameworkAgentAdapter = {
    async *streamReply(input) {
      capturedMode = input.inputMode;
      yield "Typed response";
      return "Typed response";
    },
    async close() {},
  };
  const server = new RealtimeHubServer(config(), { agent: replyAgent });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: { input: ["text"], output: ["text"], control: [], safety: [] },
    }));
    await waitFor(() => messages.some((message) => message.type === "hello.ack"));

    socket.send(JSON.stringify({ type: "user.text", text: "hello" }));
    await waitFor(() => messages.some(
      (message) => message.type === "message"
        && message.data.role === "assistant"
        && message.data.final === true,
    ));

    assert.equal(capturedMode, "text");
  } finally {
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("authenticated realtime replacement and interrupt preempt active replies without blocking the message queue", async () => {
  const replyAgent = new BlockingAgent();
  const server = new RealtimeHubServer(config({ allowInterrupt: true }), { agent: replyAgent });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: { input: ["text"], output: ["text"], control: ["interrupt"], safety: [] },
    }));
    await waitFor(() => messages.some((message) => message.type === "hello.ack"));

    socket.send(JSON.stringify({ type: "user.text", text: "block replacement" }));
    await waitFor(() => replyAgent.calls.length === 1);
    socket.send(JSON.stringify({ type: "user.text", text: "replacement" }));
    await waitFor(() => replyAgent.aborted.includes("block replacement"));
    await waitFor(() => finalAssistantMessages(messages).includes("reply:replacement"));

    socket.send(JSON.stringify({ type: "user.text", text: "block explicit interrupt" }));
    await waitFor(() => replyAgent.calls.length === 3);
    socket.send(JSON.stringify({ type: "interrupt" }));
    await waitFor(() => replyAgent.aborted.includes("block explicit interrupt"));
    await waitFor(() => messages.some((message) => message.type === "assistant.interrupted"));

    socket.send(JSON.stringify({ type: "user.text", text: "after interrupt" }));
    await waitFor(() => finalAssistantMessages(messages).includes("reply:after interrupt"));

    assert.deepEqual(replyAgent.calls.map((call) => call.userText), [
      "block replacement",
      "replacement",
      "block explicit interrupt",
      "after interrupt",
    ]);
    assert.deepEqual(replyAgent.calls[1]?.history?.map((message) => message.content), [
      "block replacement",
      "replacement",
    ]);
    assert.deepEqual(replyAgent.calls[3]?.history?.map((message) => message.content), [
      "block replacement",
      "replacement",
      "reply:replacement",
      "block explicit interrupt",
      "after interrupt",
    ]);
  } finally {
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("authenticated realtime interruption detaches stalled TTS before admitting a replacement", async () => {
  const replyAgent = new BlockingAgent();
  const tts = new FirstReplyStallingTts();
  const server = new RealtimeHubServer(
    config({ allowInterrupt: true, streamingAudio: true }),
    { agent: replyAgent, realtimeTts: tts },
  );
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: HubToClientMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "office-device",
      deviceName: "Office Device",
      credential,
      capabilities: {
        input: ["text"],
        output: ["text", "streamed_audio"],
        control: ["interrupt"],
        safety: [],
      },
    }));
    await waitFor(() => messages.some((message) => message.type === "hello.ack"));

    socket.send(JSON.stringify({ type: "user.text", text: "old reply" }));
    await tts.firstStarted;
    assert.equal(replyAgent.calls.length, 1, "the old model reply must finish before TTS stalls");

    socket.send(JSON.stringify({ type: "interrupt" }));
    await waitFor(() => messages.some((message) => message.type === "assistant.interrupted"));
    socket.send(JSON.stringify({ type: "user.text", text: "replacement" }));

    await waitFor(() => replyAgent.calls.length === 2);
    await waitFor(() => finalAssistantMessages(messages).includes("reply:replacement"));

    const oldTtsCall = tts.calls[0];
    assert.ok(oldTtsCall?.signal);
    assert.equal(oldTtsCall.signal, replyAgent.calls[0]?.signal);
    assert.equal(oldTtsCall.signal.aborted, true);
    assert.deepEqual(replyAgent.calls[1]?.history?.map((message) => message.content), [
      "old reply",
      "replacement",
    ]);
    assert.equal(finalAssistantMessages(messages).includes("reply:old reply"), false);
    assert.equal(audioPayloads(messages).includes("stale-audio:reply:old reply"), false);

    tts.releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finalAssistantMessages(messages).includes("reply:old reply"), false);
    assert.equal(audioPayloads(messages).includes("stale-audio:reply:old reply"), false);
  } finally {
    tts.releaseFirst();
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await server.close();
  }
});

test("stale authenticated connection fencing cannot detach an overlapping reconnect", async () => {
  const authority = createHubDeviceRegistryAuthority(() => registry());
  let observedAuthority: PsfnChannelContext["deviceAuthority"];
  const captureAgent: FrameworkAgentAdapter = {
    async *streamReply(input) {
      observedAuthority = input.channel?.deviceAuthority;
      yield "current";
      return "current";
    },
    async close() {},
  };
  const server = new RealtimeHubServer(config({ deviceRegistry: authority }), { agent: captureAgent });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const first = new WebSocket(`ws://127.0.0.1:${address.port}`);
  let second: WebSocket | undefined;
  const firstMessages: HubToClientMessage[] = [];
  const secondMessages: HubToClientMessage[] = [];
  first.on("message", raw => firstMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));

  try {
    await new Promise<void>(resolve => first.once("open", resolve));
    sendAuthenticatedHello(first);
    await waitFor(() => firstMessages.some(message => message.type === "hello.ack"));

    const current = new WebSocket(`ws://127.0.0.1:${address.port}`);
    second = current;
    current.on("message", raw => secondMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => current.once("open", resolve));
    sendAuthenticatedHello(current);
    await waitFor(() => secondMessages.some(message => message.type === "hello.ack"));

    first.send(JSON.stringify({ type: "ping", sentAt: "2026-07-15T00:00:00.000Z" }));
    await new Promise<void>(resolve => first.once("close", () => resolve()));
    assert.equal(firstMessages.some(message => message.type === "pong"), false);

    second.send(JSON.stringify({ type: "user.text", text: "current authority" }));
    await waitFor(() => observedAuthority !== undefined);
    assert.equal(observedAuthority?.deviceId, "office-device");
    assert.equal(observedAuthority?.enrollmentVersion, 1);
    await waitFor(() => secondMessages.some(message => (
      message.type === "message" && message.data.final === true
    )));
  } finally {
    first.close();
    second?.close();
    await server.close();
  }
});

test("active authenticated session fences revocation and rejects reconnect", async () => {
  let current = registry();
  const authority = createHubDeviceRegistryAuthority(() => current);
  const server = new RealtimeHubServer(config({ deviceRegistry: authority }), { agent: agent() });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const first = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const firstMessages: HubToClientMessage[] = [];
    first.on("message", raw => firstMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => first.once("open", resolve));
    sendAuthenticatedHello(first);
    await waitFor(() => firstMessages.some(message => message.type === "hello.ack"));

    current = registry({ enrollmentStatus: "revoked" });
    first.send(JSON.stringify({ type: "ping", sentAt: "2026-07-15T00:00:00.000Z" }));
    await new Promise<void>(resolve => first.once("close", () => resolve()));
    assert.equal(firstMessages.at(-1)?.type, "error-event");
    assert.equal(firstMessages.some(message => message.type === "pong"), false);

    const reconnect = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const reconnectMessages: HubToClientMessage[] = [];
    reconnect.on("message", raw => reconnectMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => reconnect.once("open", resolve));
    sendAuthenticatedHello(reconnect);
    await new Promise<void>(resolve => reconnect.once("close", () => resolve()));
    assert.equal(reconnectMessages.some(message => message.type === "hello.ack"), false);
  } finally {
    await server.close();
  }
});

test("active authenticated session fences a version bump and reconnects at the current version", async () => {
  let current = registry();
  const authority = createHubDeviceRegistryAuthority(() => current);
  let observedVersion: number | undefined;
  const captureAgent: FrameworkAgentAdapter = {
    async *streamReply(input) {
      observedVersion = input.channel?.deviceAuthority?.enrollmentVersion;
      yield "current";
      return "current";
    },
    async close() {},
  };
  const server = new RealtimeHubServer(config({ deviceRegistry: authority }), { agent: captureAgent });
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const first = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const firstMessages: HubToClientMessage[] = [];
    first.on("message", raw => firstMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => first.once("open", resolve));
    sendAuthenticatedHello(first);
    await waitFor(() => firstMessages.some(message => message.type === "hello.ack"));

    current = registry({ enrollmentVersion: 2 });
    first.send(JSON.stringify({ type: "ping", sentAt: "2026-07-15T00:00:00.000Z" }));
    await new Promise<void>(resolve => first.once("close", () => resolve()));
    assert.equal(firstMessages.at(-1)?.type, "error-event");

    const reconnect = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const reconnectMessages: HubToClientMessage[] = [];
    reconnect.on("message", raw => reconnectMessages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>(resolve => reconnect.once("open", resolve));
    sendAuthenticatedHello(reconnect);
    await waitFor(() => reconnectMessages.some(message => message.type === "hello.ack"));
    reconnect.send(JSON.stringify({ type: "user.text", text: "current authority" }));
    await waitFor(() => observedVersion !== undefined);
    assert.equal(observedVersion, 2);
    reconnect.close();
    await new Promise<void>(resolve => reconnect.once("close", () => resolve()));
  } finally {
    await server.close();
  }
});

function config(options: {
  allowInterrupt?: boolean;
  streamingAudio?: boolean;
  deviceRegistry?: HubDeviceRegistryAuthority;
} = {}): HubConfig {
  return {
    textOnlyMode: !options.streamingAudio, bindHost: "127.0.0.1", port: 0,
    deepgramApiKey: null,
    elevenlabsApiKey: options.streamingAudio ? "test-elevenlabs" : null,
    elevenlabsVoiceId: options.streamingAudio ? "test-voice" : null,
    elevenlabsModelId: "eleven_flash_v2_5", artifactsRoot: ".artifacts/test-auth",
    psfn: { baseUrl: "http://127.0.0.1:1/v1", model: "psfn", channelType: "satellite.endpoint", deviceAssertionIssuer: DEVICE_ASSERTION_ISSUER, satelliteClaim: {
      namespace: "satellite.endpoint", type: "text-only", channelType: "satellite.endpoint",
      capabilityProfile: "text-only", satelliteId: "hub", endpointId: "hub", displayName: "Hub",
      endpointClass: "text", locationMode: "static", telemetry: { mode: "disabled", categories: [] },
    }, voiceReplyDeadlineMs: 8_000, voiceAttemptTimeoutMs: 6_000,
      textReplyDeadlineMs: 80_000, textAttemptTimeoutMs: 75_000 },
    companion: null, homeAssistant: null, control: null,
    deviceRegistry: options.deviceRegistry ?? createHubDeviceRegistryAuthority(() => registry(undefined, options)),
    eidoversePlaceMap: null,
    voxta: { enabled: false, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null,
      chatId: null, assistantId: "assistant", assistantName: "Assistant", userId: "user", userName: "User",
      appLabel: "Test", clientVersion: "1", publicBaseUrl: null, audioFolder: null, sttStreamEnabled: false,
      visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
    sessionTtlSeconds: 60,
  };
}

function registry(
  overrides: Partial<HubDeviceIdentity> = {},
  options: { allowInterrupt?: boolean; streamingAudio?: boolean } = {},
): HubDeviceRegistry {
  return {
    schemaVersion: 1,
    devices: [{
      deviceId: "office-device", deviceName: "Office Device", satelliteId: "office",
      satelliteName: "Office", endpointId: "office-device", claimType: "room-satellite",
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      enrollmentVersion: 1,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "office",
      homeAssistantEntityIds: [],
      maxCapabilities: {
        input: ["text"],
        output: options.streamingAudio ? ["text", "streamed_audio"] : ["text"],
        control: options.allowInterrupt ? ["interrupt"] : [],
        safety: ["local_only"],
      },
      ...overrides,
    }],
  };
}

function sendAuthenticatedHello(socket: WebSocket): void {
  socket.send(JSON.stringify({
    type: "hello",
    deviceId: "office-device",
    deviceName: "Office Device",
    credential,
    capabilities: { input: ["text"], output: ["text"], control: [], safety: [] },
  }));
}

function agent(): FrameworkAgentAdapter {
  return { async *streamReply() { return ""; }, async close() {} };
}

function fixedReplyAgent(reply: string): FrameworkAgentAdapter {
  return {
    async *streamReply() {
      yield reply;
      return reply;
    },
    async close() {},
  };
}

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

class BlockingAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];
  readonly aborted: string[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    if (input.userText.startsWith("block")) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => {
          this.aborted.push(input.userText);
          reject(input.signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (input.signal?.aborted) {
          onAbort();
          return;
        }
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const response = `reply:${input.userText}`;
    yield response;
    return response;
  }

  async close(): Promise<void> {}
}

class FirstReplyStallingTts implements StreamingTtsAdapter {
  readonly calls: Array<{ text: string; signal?: AbortSignal }> = [];
  private resolveFirstStarted: () => void = () => undefined;
  private releaseStalledReply: () => void = () => undefined;
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });
  private readonly stalledReply = new Promise<void>((resolve) => {
    this.releaseStalledReply = resolve;
  });

  async *streamText(
    textStream: AsyncIterable<string>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<Buffer, void, void> {
    let text = "";
    for await (const chunk of textStream) {
      text += chunk;
    }
    const callIndex = this.calls.push({ text, signal: options?.signal }) - 1;
    if (callIndex === 0) {
      this.resolveFirstStarted();
      await this.stalledReply;
      yield Buffer.from(`stale-audio:${text}`);
      return;
    }
    yield Buffer.from(`current-audio:${text}`);
  }

  releaseFirst(): void {
    this.releaseStalledReply();
  }

  async close(): Promise<void> {
    this.releaseFirst();
  }
}

class RecordingTts implements StreamingTtsAdapter {
  readonly calls: string[] = [];

  constructor(private readonly chunks: string[]) {}

  async *streamText(textStream: AsyncIterable<string>): AsyncGenerator<Buffer, void, void> {
    let text = "";
    for await (const chunk of textStream) text += chunk;
    this.calls.push(text);
    for (const chunk of this.chunks) yield Buffer.from(chunk);
  }

  async close(): Promise<void> {}
}

function finalAssistantMessages(messages: HubToClientMessage[]): string[] {
  return messages.flatMap((message) => (
    message.type === "message"
      && message.data.role === "assistant"
      && message.data.final === true
      ? [message.data.content]
      : []
  ));
}

function audioPayloads(messages: HubToClientMessage[]): string[] {
  return messages.flatMap((message) => (
    message.type === "audio"
      ? [Buffer.from(message.data, "base64").toString("utf8")]
      : []
  ));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for websocket message");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
