import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { RealtimeHubServer } from "./server.js";
import type { HubConfig } from "../shared/env.js";
import type { HubToClientMessage } from "../shared/protocol.js";

const credential = "office-satellite-secret";

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
  assert.equal(ack.deviceName, "Office Device");
  assert.equal(ack.satelliteId, "office");
  assert.deepEqual(ack.capabilities.control, []);
  assert.deepEqual(ack.capabilities.safety, ["local_only"]);
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await server.close();
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

function config(options: { allowInterrupt?: boolean; streamingAudio?: boolean } = {}): HubConfig {
  return {
    textOnlyMode: !options.streamingAudio, bindHost: "127.0.0.1", port: 0,
    deepgramApiKey: null,
    elevenlabsApiKey: options.streamingAudio ? "test-elevenlabs" : null,
    elevenlabsVoiceId: options.streamingAudio ? "test-voice" : null,
    elevenlabsModelId: "eleven_flash_v2_5", artifactsRoot: ".artifacts/test-auth",
    psfn: { baseUrl: "http://127.0.0.1:1/v1", model: "psfn", channelType: "satellite.endpoint", satelliteClaim: {
      namespace: "satellite.endpoint", type: "text-only", channelType: "satellite.endpoint",
      capabilityProfile: "text-only", satelliteId: "hub", endpointId: "hub", displayName: "Hub",
      endpointClass: "text", locationMode: "static", telemetry: { mode: "disabled", categories: [] },
    }, voiceReplyDeadlineMs: 8_000, voiceAttemptTimeoutMs: 6_000,
      textReplyDeadlineMs: 80_000, textAttemptTimeoutMs: 75_000 },
    companion: null, homeAssistant: null, control: null,
    deviceRegistry: { schemaVersion: 1, devices: [{
      deviceId: "office-device", deviceName: "Office Device", satelliteId: "office",
      satelliteName: "Office", endpointId: "office-device", claimType: "room-satellite",
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      homeAssistantEntityIds: [],
      maxCapabilities: {
        input: ["text"],
        output: options.streamingAudio ? ["text", "streamed_audio"] : ["text"],
        control: options.allowInterrupt ? ["interrupt"] : [],
        safety: ["local_only"],
      },
    }] },
    voxta: { enabled: false, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null,
      chatId: null, assistantId: "assistant", assistantName: "Assistant", userId: "user", userName: "User",
      appLabel: "Test", clientVersion: "1", publicBaseUrl: null, audioFolder: null, sttStreamEnabled: false,
      visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
    sessionTtlSeconds: 60,
  };
}

function agent(): FrameworkAgentAdapter {
  return { async *streamReply() { return ""; }, async close() {} };
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
