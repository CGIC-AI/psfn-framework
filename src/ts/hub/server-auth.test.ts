import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import type { AgentRuntimeAdapter } from "./agent-runtime.js";
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

function config(): HubConfig {
  return {
    agentRuntime: "psfn", textOnlyMode: true, bindHost: "127.0.0.1", port: 0,
    deepgramApiKey: null, elevenlabsApiKey: null, elevenlabsVoiceId: null,
    elevenlabsModelId: "eleven_flash_v2_5", artifactsRoot: ".artifacts/test-auth",
    psfn: { baseUrl: "http://127.0.0.1:1/v1", model: "psfn", channelType: "satellite.endpoint", satelliteClaim: {
      namespace: "satellite.endpoint", type: "text-only", channelType: "satellite.endpoint",
      capabilityProfile: "text-only", satelliteId: "hub", endpointId: "hub", displayName: "Hub",
      endpointClass: "text", locationMode: "static", telemetry: { mode: "disabled", categories: [] },
    } },
    hermes: null, companion: null, homeAssistant: null, control: null,
    deviceRegistry: { schemaVersion: 1, devices: [{
      deviceId: "office-device", deviceName: "Office Device", satelliteId: "office",
      satelliteName: "Office", endpointId: "office-device", claimType: "room-satellite",
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      maxCapabilities: { input: ["text"], output: ["text"], control: [], safety: ["local_only"] },
    }] },
    voxta: { enabled: false, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null,
      chatId: null, assistantId: "assistant", assistantName: "Assistant", userId: "user", userName: "User",
      appLabel: "Test", clientVersion: "1", publicBaseUrl: null, audioFolder: null, sttStreamEnabled: false,
      visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
    sessionTtlSeconds: 60,
  };
}

function agent(): AgentRuntimeAdapter {
  return { async *streamReply() { return ""; }, async close() {} };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for websocket message");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
