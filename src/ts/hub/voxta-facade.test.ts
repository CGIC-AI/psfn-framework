import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket, { type RawData } from "ws";

import { wrapPcmAsWav } from "../shared/audio.js";
import type { HubConfig } from "../shared/env.js";
import type { AgentRuntimeAdapter } from "./agent-runtime.js";
import type { PsfnChannelContext } from "./embodied-session.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { RealtimeHubServer } from "./server.js";
import type { ConversationMessage } from "./session-store.js";

const SIGNALR_RECORD_SEPARATOR = "\x1e";

class FakeAgent implements AgentRuntimeAdapter {
  readonly calls: Array<{
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }> = [];

  async *streamReply(input: {
    userText: string;
    conversationId?: string;
    history?: ConversationMessage[];
    channel?: PsfnChannelContext;
  }): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Hello";
    yield " from PSFN";
    return "Hello from PSFN";
  }

  async close(): Promise<void> {}
}

test("Voxta facade negotiates SignalR and routes SendMessage into the embodied session", async () => {
  const agent = new FakeAgent();
  const server = new RealtimeHubServer(testHubConfig(), { agent, voxtaTts: null });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const negotiate = await fetch(`${baseUrl}/hub/negotiate?negotiateVersion=1`, {
      method: "POST",
    });
    assert.equal(negotiate.status, 200);
    const negotiation = await negotiate.json() as {
      connectionToken: string;
      availableTransports: Array<{ transport: string }>;
    };
    assert.equal(negotiation.availableTransports[0]?.transport, "WebSockets");

    socket = await openSocket(
      `ws://127.0.0.1:${address.port}/hub?id=${encodeURIComponent(negotiation.connectionToken)}`,
    );
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);

    socket.send(encodeFrame(invocation("auth-1", acidBubblesAuthenticate())));
    const welcome = await waitForVoxta(frames, "welcome");
    assert.equal(welcome.apiVersion, "2025-11");
    assert.equal(welcome.voxtaServerVersion, "1.1.3");
    assert.equal(welcome.registeredClientVersion, "1.1.1");
    const configuration = await waitForVoxta(frames, "configuration");
    assertAcidBubblesConfiguration(configuration);
    await waitForCompletion(frames, "auth-1");

    socket.send(encodeFrame(invocation("start-1", {
      $type: "startChat",
    })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    const sessionId = String(chatStarted.sessionId);
    assertGuid(sessionId);
    assertGuid(chatStarted.chatId);
    assertAcidBubblesChatStarted(chatStarted);
    await waitForCompletion(frames, "start-1");

    socket.send(encodeFrame(invocation("trigger-1", {
      $type: "triggerAction",
      sessionId,
      value: "wave",
      arguments: { intensity: 1 },
    })));
    const appTrigger = await waitForVoxta(frames, "appTrigger");
    await waitForCompletion(frames, "trigger-1");
    assert.equal(appTrigger.name, "wave");
    assert.deepEqual(appTrigger.arguments, ["1"]);

    socket.send(encodeFrame(invocation("trigger-2", {
      $type: "triggerAction",
      sessionId,
      value: "unsafeAction",
    })));
    const deniedTrigger = await waitForCompletion(frames, "trigger-2");
    assert.match(String(deniedTrigger.error), /not allowlisted/);

    socket.send(encodeFrame(invocation("send-1", {
      $type: "send",
      sessionId,
      text: "hello there",
    })));
    const replyGenerating = await waitForVoxta(frames, "replyGenerating");
    assert.equal(replyGenerating.sessionId, sessionId);
    assertGuid(replyGenerating.messageId);
    assertGuid(replyGenerating.senderId);
    assert.equal(replyGenerating.role, "Assistant");
    assert.equal(replyGenerating.isNarration, false);
    const replyStart = await waitForVoxta(frames, "replyStart");
    assert.equal(replyStart.sessionId, sessionId);
    assert.equal(replyStart.messageId, replyGenerating.messageId);
    assertGuid(replyStart.senderId);
    const firstChunk = await waitForVoxta(frames, "replyChunk");
    assert.equal(firstChunk.sessionId, sessionId);
    assert.equal(firstChunk.messageId, replyGenerating.messageId);
    assertGuid(firstChunk.senderId);
    assert.equal(firstChunk.text, "Hello from PSFN");
    assert.equal(firstChunk.audioUrl, "silence:0");
    assert.equal(firstChunk.startIndex, 0);
    assert.equal(firstChunk.endIndex, 15);
    assert.equal(firstChunk.isNarration, false);
    assert.equal(firstChunk.audioGapMs, 0);
    const replyEnd = await waitForVoxta(frames, "replyEnd");
    assert.equal(replyEnd.sessionId, sessionId);
    assert.equal(replyEnd.messageId, replyGenerating.messageId);
    assertGuid(replyEnd.senderId);
    await waitForCompletion(frames, "send-1");

    assert.deepEqual(voxtaPayloads(frames).filter((payload) => payload.$type === "message"), []);
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0]?.userText, "hello there");
    assert.equal(agent.calls[0]?.conversationId, sessionId);
    assert.equal(agent.calls[0]?.channel?.sourceSatelliteId, "voxta-vam");
    assert.ok(
      agent.calls[0]?.channel?.activeSatellites[0]?.capabilities.output.includes("local_file_audio"),
    );
    assert.ok(
      agent.calls[0]?.channel?.activeSatellites[0]?.capabilities.output.includes("action"),
    );
  } finally {
    socket?.close();
    await server.close();
  }
});

test("Voxta facade writes VaM-playable WAV artifacts when VOXTA audio folder is configured", async () => {
  const audioFolder = fs.mkdtempSync(path.join(os.tmpdir(), "voxta-vam-audio-"));
  const agent = new FakeAgent();
  const ttsCalls: string[] = [];
  const server = new RealtimeHubServer(testHubConfig({ audioFolder }), {
    agent,
    voxtaTts: {
      async synthesizeWav(text: string): Promise<Buffer> {
        ttsCalls.push(text);
        return wrapPcmAsWav(Buffer.alloc(320), {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
        });
      },
    },
  });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    socket = await openSocket(`ws://127.0.0.1:${address.port}/hub`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);
    socket.send(encodeFrame(invocation("auth-audio", acidBubblesAuthenticate())));
    await waitForVoxta(frames, "configuration");
    await waitForCompletion(frames, "auth-audio");
    socket.send(encodeFrame(invocation("start-audio", { $type: "startChat" })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    await waitForCompletion(frames, "start-audio");

    socket.send(encodeFrame(invocation("send-audio", {
      $type: "send",
      sessionId: chatStarted.sessionId,
      text: "say this",
    })));
    const chunk = await waitForVoxta(frames, "replyChunk");
    await waitForCompletion(frames, "send-audio");

    assert.deepEqual(ttsCalls, ["Hello from PSFN"]);
    assert.equal(typeof chunk.audioUrl, "string");
    assert.match(String(chunk.audioUrl), /\.wav$/);
    assert.equal(path.dirname(String(chunk.audioUrl)), audioFolder);
    assert.equal(fs.existsSync(String(chunk.audioUrl)), true);
    const wav = fs.readFileSync(String(chunk.audioUrl));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  } finally {
    socket?.close();
    await server.close();
    fs.rmSync(audioFolder, { recursive: true, force: true });
  }
});

test("Voxta facade serves proxy-fetchable WAV artifacts when no local VaM audio folder is configured", async () => {
  const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voxta-http-audio-"));
  const agent = new FakeAgent();
  const ttsCalls: string[] = [];
  const server = new RealtimeHubServer(testHubConfig({ artifactsRoot }), {
    agent,
    voxtaTts: {
      async synthesizeWav(text: string): Promise<Buffer> {
        ttsCalls.push(text);
        return wrapPcmAsWav(Buffer.alloc(320), {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
        });
      },
    },
  });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    socket = await openSocket(`ws://127.0.0.1:${address.port}/hub`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);
    socket.send(encodeFrame(invocation("auth-http-audio", acidBubblesAuthenticate())));
    await waitForVoxta(frames, "configuration");
    await waitForCompletion(frames, "auth-http-audio");
    socket.send(encodeFrame(invocation("start-http-audio", { $type: "startChat" })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    await waitForCompletion(frames, "start-http-audio");

    socket.send(encodeFrame(invocation("send-http-audio", {
      $type: "send",
      sessionId: chatStarted.sessionId,
      text: "say this",
    })));
    const chunk = await waitForVoxta(frames, "replyChunk");
    await waitForCompletion(frames, "send-http-audio");

    assert.deepEqual(ttsCalls, ["Hello from PSFN"]);
    assert.equal(typeof chunk.audioUrl, "string");
    assert.match(String(chunk.audioUrl), new RegExp(`^http://127\\.0\\.0\\.1:${address.port}/api/voxta/audio/.+\\.wav$`));
    const audio = await fetch(String(chunk.audioUrl));
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/x-wav");
    const wav = Buffer.from(await audio.arrayBuffer());
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  } finally {
    socket?.close();
    await server.close();
    fs.rmSync(artifactsRoot, { recursive: true, force: true });
  }
});

test("Voxta facade accepts AcidBubbles-style raw /hub WebSocket without negotiate", async () => {
  const agent = new FakeAgent();
  const server = new RealtimeHubServer(testHubConfig(), { agent, voxtaTts: null });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    socket = await openSocket(`ws://127.0.0.1:${address.port}/hub`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);

    socket.send(encodeFrame(invocation("auth-raw", acidBubblesAuthenticate())));
    const welcome = await waitForVoxta(frames, "welcome");
    assert.equal(welcome.apiVersion, "2025-11");
    assert.equal(welcome.registeredClientVersion, "1.1.1");
    const configuration = await waitForVoxta(frames, "configuration");
    assertAcidBubblesConfiguration(configuration);
    const configurationId = activeConfigurationId(configuration);
    await waitForCompletion(frames, "auth-raw");

    const toggleStt = await fetch(`${baseUrl}/api/configurations/${configurationId}/services/SpeechToText`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleStt.status, 200);
    const sttDisabled = await waitForVoxta(
      frames,
      "configuration",
      (payload) => serviceEnabled(payload, "SpeechToText") === false,
    );
    assert.equal(serviceEnabled(sttDisabled, "TextToSpeech"), true);

    const toggleTts = await fetch(`${baseUrl}/api/configurations/${configurationId}/services/TextToSpeech`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleTts.status, 200);
    await waitForVoxta(
      frames,
      "configuration",
      (payload) => serviceEnabled(payload, "TextToSpeech") === false,
    );

    const proxyConfigurationId = crypto.randomUUID();
    const toggleUnknownVision = await fetch(`${baseUrl}/api/configurations/${proxyConfigurationId}/services/ComputerVision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggleUnknownVision.status, 200);
    await waitForVoxta(
      frames,
      "configuration",
      (payload) => activeConfigurationId(payload) === proxyConfigurationId &&
        serviceEnabled(payload, "ComputerVision") === true,
    );

    socket.send(encodeFrame(invocation("start-raw", { $type: "startChat" })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    assertAcidBubblesChatStarted(chatStarted);
    await waitForCompletion(frames, "start-raw");

    socket.send(encodeFrame(invocation("playback-start", {
      $type: "speechPlaybackStart",
      sessionId: chatStarted.sessionId,
      messageId: crypto.randomUUID(),
      startIndex: 0,
      endIndex: 5,
      duration: 0.25,
      isNarration: false,
    })));
    await waitForCompletion(frames, "playback-start");

    socket.send(encodeFrame(invocation("playback-complete", {
      $type: "speechPlaybackComplete",
      sessionId: chatStarted.sessionId,
      messageId: crypto.randomUUID(),
    })));
    await waitForCompletion(frames, "playback-complete");
  } finally {
    socket?.close();
    await server.close();
  }
});

test("Voxta facade accepts proxy microphone stream and emits STT events", async () => {
  const agent = new FakeAgent();
  const sttCalls: Array<{ specSampleRate: number; bytes: number }> = [];
  const server = new RealtimeHubServer(testHubConfig({ sttStreamEnabled: true }), {
    agent,
    voxtaTts: null,
    voxtaStt: {
      async transcribePcm(input): Promise<{ text: string; provider: string }> {
        sttCalls.push({
          specSampleRate: input.spec.sampleRate,
          bytes: input.pcm.length,
        });
        return { text: "hello from mic", provider: "fake-stt" };
      },
    },
  });
  let socket: WebSocket | null = null;
  let audioSocket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    socket = await openSocket(`ws://127.0.0.1:${address.port}/hub`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);
    socket.send(encodeFrame(invocation("auth-stt", acidBubblesAuthenticate())));
    await waitForVoxta(frames, "configuration");
    await waitForCompletion(frames, "auth-stt");
    socket.send(encodeFrame(invocation("start-stt", { $type: "startChat" })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    const recordingRequest = await waitForVoxta(frames, "recordingRequest");
    assert.equal(recordingRequest.sessionId, chatStarted.sessionId);
    assert.equal(recordingRequest.enabled, true);
    await waitForCompletion(frames, "start-stt");

    audioSocket = await openSocket(
      `ws://127.0.0.1:${address.port}/ws/audio/input/stream?sessionId=${encodeURIComponent(String(chatStarted.sessionId))}`,
    );
    audioSocket.send(JSON.stringify({
      sampleRate: 16000,
      channels: 1,
      bufferMilliseconds: 30,
      bitsPerSample: 16,
      contentType: "audio/wav",
    }));
    audioSocket.send(Buffer.alloc(320));
    audioSocket.close();

    const speechStart = await waitForVoxta(frames, "speechRecognitionStart");
    assert.equal(speechStart.sessionId, chatStarted.sessionId);
    const partial = await waitForVoxta(frames, "speechRecognitionPartial");
    assert.equal(partial.text, "hello from mic");
    const end = await waitForVoxta(frames, "speechRecognitionEnd");
    assert.equal(end.sessionId, chatStarted.sessionId);
    assert.equal(end.text, "hello from mic");
    assert.deepEqual(sttCalls, [{ specSampleRate: 16000, bytes: 320 }]);
  } finally {
    audioSocket?.close();
    socket?.close();
    await server.close();
  }
});

test("Voxta facade accepts AcidBubbles vision capture uploads and exposes metadata", async () => {
  const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voxta-vision-artifacts-"));
  const agent = new FakeAgent();
  const server = new RealtimeHubServer(testHubConfig({
    artifactsRoot,
    visionCaptureTimeoutMs: 1_000,
  }), { agent, voxtaTts: null });
  let socket: WebSocket | null = null;

  try {
    await server.start();
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    socket = await openSocket(`ws://127.0.0.1:${address.port}/hub`);
    const frames: unknown[] = [];
    socket.on("message", (raw) => {
      frames.push(...decodeSignalRFrames(raw));
    });

    socket.send(encodeFrame({ protocol: "json", version: 1 }));
    await waitForFrame(frames, (frame) => isRecord(frame) && Object.keys(frame).length === 0);
    socket.send(encodeFrame(invocation("auth-vision", acidBubblesAuthenticate())));
    const configuration = await waitForVoxta(frames, "configuration");
    const configurationId = activeConfigurationId(configuration);
    await waitForCompletion(frames, "auth-vision");
    socket.send(encodeFrame(invocation("start-vision", { $type: "startChat" })));
    const chatStarted = await waitForVoxta(frames, "chatStarted");
    await waitForCompletion(frames, "start-vision");

    const toggleVision = await fetch(`${baseUrl}/api/configurations/${configurationId}/services/ComputerVision`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggleVision.status, 200);
    await waitForVoxta(
      frames,
      "configuration",
      (payload) => serviceEnabled(payload, "ComputerVision") === true,
    );

    socket.send(encodeFrame(invocation("send-vision", {
      $type: "send",
      sessionId: chatStarted.sessionId,
      text: "what do you see",
    })));
    const screenRequest = await waitForVoxta(
      frames,
      "visionCaptureRequest",
      (payload) => payload.source === "Screen",
    );
    const eyesRequest = await waitForVoxta(
      frames,
      "visionCaptureRequest",
      (payload) => payload.source === "Eyes",
    );
    const upload = multipartBody("file", "virtamate.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const screenUpload = await fetch(
      `${baseUrl}/api/vision/requests/${screenRequest.visionCaptureRequestId}/send`
        + `?sessionId=${chatStarted.sessionId}&source=Screen&label=virtamate`,
      {
        method: "POST",
        headers: { "Content-Type": upload.contentType },
        body: new Uint8Array(upload.body),
      },
    );
    assert.equal(screenUpload.status, 200);
    const eyesCancel = await fetch(
      `${baseUrl}/api/vision/requests/${eyesRequest.visionCaptureRequestId}?sessionId=${chatStarted.sessionId}`,
      { method: "DELETE" },
    );
    assert.equal(eyesCancel.status, 200);
    await waitForVoxta(frames, "replyEnd");
    await waitForCompletion(frames, "send-vision");

    assert.equal(agent.calls.length, 1);
    const capture = agent.calls[0]?.channel?.visionCaptures?.[0];
    assert.ok(capture);
    assert.equal(capture.requestId, screenRequest.visionCaptureRequestId);
    assert.equal(capture.sessionId, chatStarted.sessionId);
    assert.equal(capture.source, "Screen");
    assert.equal(capture.label, "virtamate");
    assert.equal(capture.mimeType, "image/jpeg");
    assert.equal(capture.bytes, 4);
    assert.equal(fs.existsSync(capture.filePath), true);
    assert.equal(fs.readFileSync(capture.filePath).toString("hex"), "ffd8ffd9");
    const image = agent.calls[0]?.channel?.visionCaptureImages?.[0];
    assert.ok(image);
    assert.equal(image.dataBase64, "/9j/2Q==");
    assert.equal(JSON.stringify(agent.calls[0]?.channel?.visionCaptures).includes("/9j/2Q=="), false);
  } finally {
    socket?.close();
    await server.close();
    fs.rmSync(artifactsRoot, { recursive: true, force: true });
  }
});

function testHubConfig(overrides: {
  artifactsRoot?: string;
  audioFolder?: string | null;
  sttStreamEnabled?: boolean;
  visionCaptureTimeoutMs?: number;
} = {}): HubConfig {
  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "voxta-avatar",
    satelliteId: "voxta-vam",
    endpointId: "voxta-vam",
    displayName: "Voxta VaM",
  });
  return {
    agentRuntime: "psfn",
    bindHost: "127.0.0.1",
    port: 0,
    deepgramApiKey: "test-deepgram",
    elevenlabsApiKey: "test-elevenlabs",
    elevenlabsVoiceId: "test-voice",
    elevenlabsModelId: "eleven_flash_v2_5",
    artifactsRoot: overrides.artifactsRoot ?? ".artifacts/test-voxta",
    psfn: {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test",
      model: "psfn",
      channelType: satelliteClaim.channelType,
      satelliteClaim,
    },
    hermes: null,
    voxta: {
      enabled: true,
      satelliteId: "voxta-vam",
      satelliteName: "Voxta VaM",
      assistantId: "psfn-assistant",
      assistantName: "PSFN",
      userId: "voxta-user",
      userName: "User",
      appLabel: "PSFN Satellite Hub",
      clientVersion: "1.2.1",
      publicBaseUrl: null,
      audioFolder: overrides.audioFolder ?? null,
      sttStreamEnabled: overrides.sttStreamEnabled ?? false,
      visionCaptureTimeoutMs: overrides.visionCaptureTimeoutMs ?? 1_500,
      actionAllowlist: ["wave"],
    },
    sessionTtlSeconds: 300,
  };
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function invocation(invocationId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 1,
    invocationId,
    target: "SendMessage",
    arguments: [payload],
  };
}

function acidBubblesAuthenticate(): Record<string, unknown> {
  return {
    $type: "authenticate",
    client: "Voxta.VirtAMate",
    clientVersion: "1.1.1",
    scope: ["role:app"],
    capabilities: {
      audioOutput: "LocalFile",
      audioFolder: "C:\\VaM\\Custom\\Sounds\\Voxta",
      acceptedAudioContentTypes: ["audio/x-wav"],
      visionCapture: "PostImage",
      visionSources: ["Screen", "Eyes"],
    },
  };
}

function multipartBody(
  fieldName: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): { contentType: string; body: Buffer } {
  const boundary = `----psfn-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`
      + `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([head, data, tail]),
  };
}

function assertAcidBubblesConfiguration(payload: Record<string, unknown>): void {
  const configurations = payload.configurations;
  assert.ok(Array.isArray(configurations));
  assert.ok(configurations.length >= 1);
  const active = activeConfiguration(payload);
  assert.ok(isRecord(active));
  assertGuid(active.id);
  assert.ok(isRecord(active.services));
  assertServiceEnabled(active.services, "SpeechToText", true);
  assertServiceEnabled(active.services, "TextToSpeech", true);
  assertServiceEnabled(active.services, "ComputerVision", false);
}

function activeConfiguration(payload: Record<string, unknown>): Record<string, unknown> {
  const configurations = payload.configurations;
  assert.ok(Array.isArray(configurations));
  const active = configurations.find((candidate) => isRecord(candidate) && candidate.isDefault === true);
  if (isRecord(active)) {
    return active;
  }
  const fallback = configurations[0];
  assert.ok(isRecord(fallback));
  return fallback;
}

function activeConfigurationId(payload: Record<string, unknown>): string {
  const id = activeConfiguration(payload).id;
  assertGuid(id);
  return id;
}

function serviceEnabled(payload: Record<string, unknown>, name: string): boolean | undefined {
  const active = activeConfiguration(payload);
  if (!isRecord(active.services)) {
    return undefined;
  }
  const service = active.services[name];
  if (!isRecord(service) || typeof service.enabled !== "boolean") {
    return undefined;
  }
  return service.enabled;
}

function assertServiceEnabled(services: Record<string, unknown>, name: string, enabled: boolean): void {
  const service = services[name];
  assert.ok(isRecord(service), `Missing service ${name}`);
  assert.equal(service.enabled, enabled);
}

function assertAcidBubblesChatStarted(payload: Record<string, unknown>): void {
  assertGuid(payload.sessionId);
  assertGuid(payload.chatId);
  assert.equal(payload.title, "PSFN");
  assert.equal(payload.chatStyle, "Roleplay");
  assert.ok(Array.isArray(payload.messages));
  assert.ok(Array.isArray(payload.augmentations));
  assert.ok(isRecord(payload.user));
  assertGuid(payload.user.id);
  assert.ok(Array.isArray(payload.characters));
  assert.ok(isRecord(payload.characters[0]));
  assertGuid(payload.characters[0].id);
  assertGuid(payload.servicesConfigurationsSetId);
  assert.ok(isRecord(payload.context));
  assert.ok(Array.isArray(payload.context.flags));
  assert.ok(Array.isArray(payload.context.characters));
  assert.ok(Array.isArray(payload.context.actions));
  assert.ok(isRecord(payload.context.roles));
  assert.ok(isRecord(payload.services));
  assertServiceName(payload.services, "textToSpeech");
  assertServiceName(payload.services, "speechToText");
  assertServiceName(payload.services, "actionInference");
}

function assertServiceName(services: Record<string, unknown>, name: string): void {
  const service = services[name];
  assert.ok(isRecord(service), `Missing chat service ${name}`);
  assert.equal(typeof service.serviceName, "string");
  assert.notEqual(service.serviceName, "");
}

function assertGuid(value: unknown): asserts value is string {
  assert.equal(typeof value, "string");
  assert.match(String(value), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

function encodeFrame(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}${SIGNALR_RECORD_SEPARATOR}`;
}

function decodeSignalRFrames(raw: RawData): unknown[] {
  return raw
    .toString("utf8")
    .split(SIGNALR_RECORD_SEPARATOR)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as unknown);
}

async function waitForVoxta(
  frames: unknown[],
  type: string,
  predicate: (payload: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return waitForFrame(frames, (frame) => {
    if (!isRecord(frame) || frame.type !== 1 || frame.target !== "ReceiveMessage") {
      return false;
    }
    const payload = Array.isArray(frame.arguments) ? frame.arguments[0] : undefined;
    return isRecord(payload) && payload.$type === type && predicate(payload);
  }).then((frame) => {
    const payload = (frame as { arguments: unknown[] }).arguments[0];
    assert.ok(isRecord(payload));
    return payload;
  });
}

function voxtaPayloads(frames: unknown[]): Array<Record<string, unknown>> {
  return frames.flatMap((frame) => {
    if (!isRecord(frame) || frame.type !== 1 || frame.target !== "ReceiveMessage") {
      return [];
    }
    const payload = Array.isArray(frame.arguments) ? frame.arguments[0] : undefined;
    return isRecord(payload) ? [payload] : [];
  });
}

async function waitForCompletion(frames: unknown[], invocationId: string): Promise<Record<string, unknown>> {
  return waitForFrame(frames, (frame) => (
    isRecord(frame) &&
    frame.type === 3 &&
    frame.invocationId === invocationId
  ));
}

async function waitForFrame(
  frames: unknown[],
  predicate: (frame: unknown) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (isRecord(frame)) {
      return frame;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for SignalR frame. Received: ${JSON.stringify(frames)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
