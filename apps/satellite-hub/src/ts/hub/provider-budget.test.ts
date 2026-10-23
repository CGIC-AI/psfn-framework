import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { HubConfig } from "../shared/env.js";
import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import { createHubDeviceRegistryAuthority } from "./device-registry.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { RealtimeHubServer } from "./server.js";
import { CompanionBrowserSpeech } from "./companion-browser-speech.js";
import { HubResources } from "./transport-resources.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";

const credential = "provider-budget-test-secret";
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await delay(5);
  assert.ok(predicate(), "expected protocol outcome within one second");
}

function runtime(root: string): HubConfig {
  return {
    textOnlyMode: true, bindHost: "127.0.0.1", port: 0, deepgramApiKey: null,
    elevenlabsApiKey: null, elevenlabsVoiceId: null, elevenlabsModelId: "test",
    artifactsRoot: path.join(root, "artifacts"), companion: null, homeAssistant: null, control: null,
    eidoversePlaceMap: null, location: null, sessionTtlSeconds: 60,
    access: { developerMode: false, allowedOrigins: [] },
    limits: { maxProviderOperations: 1, providerTimeoutMs: 50, authenticationTimeoutMs: 80 },
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
      maxCapabilities: { input: ["text"], output: ["text", "streamed_audio"], control: ["interrupt"], safety: ["local_only"] },
    }] })),
    voxta: { enabled: true, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null, chatId: null,
      assistantId: "assistant", assistantName: "Assistant", userId: "user", userName: "User", appLabel: "Test", clientVersion: "1",
      publicBaseUrl: null, audioFolder: null, sttStreamEnabled: false, visionCaptureTimeoutMs: 1000, actionAllowlist: [] },
  };
}

type Client = { socket: WebSocket; frames: Record<string, unknown>[]; send(text: string): void };
async function connect(server: RealtimeHubServer, surface: "realtime" | "voxta", audio = false): Promise<Client> {
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/${surface === "voxta" ? "hub" : ""}`,
    { headers: { Authorization: `Bearer ${credential}` } });
  const frames: Record<string, unknown>[] = [];
  socket.on("message", raw => {
    for (const item of raw.toString().split("\x1e").filter(Boolean)) {
      const frame = JSON.parse(item) as { arguments?: Record<string, unknown>[] };
      frames.push(frame.arguments?.[0] ?? frame);
    }
  });
  await once(socket, "open");
  const invoke = (payload: Record<string, unknown>): void => socket.send(JSON.stringify({ type: 1, target: "SendMessage", arguments: [payload] }));
  let send: (text: string) => void;
  if (surface === "voxta") {
    invoke({ $type: "authenticate" }); invoke({ $type: "startChat" });
    await until(() => frames.some(frame => frame.$type === "chatStarted"));
    send = text => invoke({ $type: "send", text });
  } else {
    socket.send(JSON.stringify({ type: "hello", deviceId: "test-device", credential,
      capabilities: { input: ["text"], output: audio ? ["text", "streamed_audio"] : ["text"], control: ["interrupt"], safety: ["local_only"] } }));
    await until(() => frames.some(frame => frame.type === "hello.ack"));
    send = text => socket.send(JSON.stringify({ type: "user.text", text }));
  }
  return { socket, frames, send };
}

function stalledModel(): { agent: FrameworkAgentAdapter; calls: string[]; histories: string[][]; release(): void } {
  const calls: string[] = [];
  const histories: string[][] = [];
  const pending = new Set<() => void>();
  return { calls, histories, release: () => { for (const release of pending) release(); }, agent: {
    async *streamReply(input) {
      calls.push(input.userText);
      histories.push(input.history?.map(message => message.content) ?? []);
      if (input.userText.startsWith("hold")) await new Promise<void>(resolve => {
        const release = (): void => { pending.delete(release); resolve(); }; pending.add(release);
      });
      yield "Allowed reply"; return "Allowed reply";
    }, async close() {},
  } };
}

for (const surface of ["realtime", "voxta"] as const) {
  test(`${surface} model timeout cannot replace cancellation-ignoring work across five authenticated reconnects`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-budget-"));
    const model = stalledModel(); const config = runtime(root);
    const server = new RealtimeHubServer(config, { agent: model.agent, voxtaTts: null });
    const clients: Client[] = [];
    await server.start();
    try {
      const first = await connect(server, surface); clients.push(first); first.send("hold first");
      await until(() => model.calls.length === 1); await delay(120);
      first.socket.close(); await once(first.socket, "close");
      const artifacts = fs.existsSync(config.artifactsRoot) ? fs.readdirSync(config.artifactsRoot, { recursive: true }) : [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const client = await connect(server, surface); clients.push(client); client.send(`rejected ${attempt}`);
        await until(() => client.frames.some(frame => frame.type === "error-event" || frame.$type === "error"));
        assert.equal(model.calls.length, 1, "provider invocation exceeds the global budget");
        assert.equal(client.frames.some(frame => frame.$type === "replyChunk" || frame.type === "audio" || frame.type === "message"), false);
        client.socket.close(); await once(client.socket, "close");
      }
      assert.deepEqual(fs.existsSync(config.artifactsRoot) ? fs.readdirSync(config.artifactsRoot, { recursive: true }) : [], artifacts);
      model.release(); await delay(20);
      const recovered = await connect(server, surface); clients.push(recovered); recovered.send("recovered");
      await until(() => model.calls.length === 2);
      assert.deepEqual(model.histories[1], ["hold first", "recovered"], "rejected turns must never enter history");
      await until(() => recovered.frames.some(frame => frame.$type === "replyEnd"
        || frame.type === "message" && (frame.data as { final?: boolean; role?: string }).final && (frame.data as { role?: string }).role === "assistant"));
    } finally {
      model.release(); for (const client of clients) client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("exact global capacity is shared by realtime and Voxta and one-over invokes neither model nor TTS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-mixed-"));
  const config = runtime(root); config.limits = { ...config.limits, maxProviderOperations: 2 };
  const model = stalledModel(); let ttsCalls = 0;
  const server = new RealtimeHubServer(config, { agent: model.agent, voxtaTts: {
    async synthesizeWav() { ttsCalls += 1; return Buffer.alloc(0); },
  } });
  const clients: Client[] = []; await server.start();
  try {
    for (const surface of ["realtime", "voxta"] as const) {
      const client = await connect(server, surface); clients.push(client); client.send(`hold ${surface}`);
      await until(() => model.calls.length === clients.length);
    }
    await delay(120);
    const excess = await connect(server, "voxta"); clients.push(excess); excess.send("one over");
    await until(() => excess.frames.some(frame => frame.$type === "error"));
    assert.equal(model.calls.length, 2); assert.equal(ttsCalls, 0);
    assert.equal(excess.frames.some(frame => ["replyStart", "replyChunk", "replyEnd"].includes(String(frame.$type))), false);
    model.release(); await delay(20); excess.send("recovered mixed");
    await until(() => excess.frames.some(frame => frame.$type === "replyEnd"));
    assert.equal(model.calls.length, 3); assert.equal(ttsCalls, 1);
    assert.deepEqual(model.histories[2], ["hold voxta", "recovered mixed"]);
  } finally {
    model.release(); for (const client of clients) client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const surface of ["realtime", "voxta"] as const) {
  test(`${surface} cancellation-ignoring TTS retains the global slot across mixed-surface reconnects`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-tts-"));
    const config = runtime(root); config.textOnlyMode = false; config.elevenlabsApiKey = "test"; config.elevenlabsVoiceId = "test";
    const model = stalledModel(); let ttsCalls = 0; let release = (): void => {};
    const synthesize = async (): Promise<Buffer> => {
      ttsCalls += 1;
      if (ttsCalls === 1) await new Promise<void>(resolve => { release = resolve; });
      return Buffer.from("invented audio fixture");
    };
    const server = new RealtimeHubServer(config, { agent: model.agent,
      realtimeTts: { async *streamText() { yield await synthesize(); }, async close() {} },
      voxtaTts: { synthesizeWav: synthesize } });
    const clients: Client[] = []; await server.start();
    try {
      const first = await connect(server, surface, true); clients.push(first); first.send("first speech");
      await until(() => ttsCalls === 1); await delay(120);
      first.socket.close(); await once(first.socket, "close");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const other = await connect(server, attempt % 2 === 0 ? "voxta" : "realtime"); clients.push(other); other.send("must not start");
        await until(() => other.frames.some(frame => frame.type === "error-event" || frame.$type === "error"));
        assert.equal(model.calls.length, 1); assert.equal(ttsCalls, 1);
        assert.equal(other.frames.some(frame => frame.type === "message" || frame.type === "audio" || frame.$type === "replyChunk"), false);
        other.socket.close(); await once(other.socket, "close");
      }
      release(); await delay(20);
      assert.equal(first.frames.some(frame => frame.type === "audio" || frame.$type === "replyChunk"), false, "late audio stays discarded");
      const recovered = await connect(server, surface, true); clients.push(recovered); recovered.send("speech recovered");
      await until(() => recovered.frames.some(frame => frame.type === "audio" || frame.$type === "replyChunk"));
      assert.equal(ttsCalls, 2);
    } finally {
      release(); for (const client of clients) client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("shutdown detaches stalled model work and a stopped Hub cannot restart around its quarantine", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-stop-"));
  const model = stalledModel(); const config = runtime(root);
  const server = new RealtimeHubServer(config, { agent: model.agent }); await server.start();
  const client = await connect(server, "voxta"); client.send("hold shutdown");
  try {
    await until(() => model.calls.length === 1);
    const started = Date.now(); await assert.rejects(server.close(), /Hub shutdown failed/);
    assert.ok(Date.now() - started < 500); assert.equal(server.address(), null);
    await assert.rejects(server.start(), /Hub has stopped/);
    assert.equal(model.calls.length, 1);
    model.release(); await delay(20);
    const replacement = new RealtimeHubServer(runtime(root), { agent: model.agent }); await replacement.start();
    const recovered = await connect(replacement, "realtime");
    try { recovered.send("after completed shutdown"); await until(() => model.calls.length === 2); }
    finally { recovered.socket.terminate(); await replacement.close(); }
  } finally { model.release(); client.socket.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const surface of ["realtime", "voxta"] as const) {
  test(`${surface} interrupt detaches promptly but pending next and iterator return both retain admission`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-return-"));
    const config = runtime(root); config.limits = { ...config.limits, providerTimeoutMs: 1000 };
    let calls = 0; let cleanupStarted = false; let modelSignal: AbortSignal | undefined;
    let releaseNext = (): void => {}; let releaseReturn = (): void => {};
    const server = new RealtimeHubServer(config, { agent: {
      async *streamReply(input) {
        calls += 1;
        if (calls === 1) {
          modelSignal = input.signal;
          try { await new Promise<void>(resolve => { releaseNext = resolve; }); yield "discarded"; }
          finally { cleanupStarted = true; await new Promise<void>(resolve => { releaseReturn = resolve; }); }
        } else yield "recovered";
        return "";
      }, async close() {},
    }, voxtaTts: null });
    await server.start(); const client = await connect(server, surface);
    try {
      client.send("first"); await until(() => calls === 1);
      const started = Date.now();
      client.socket.send(JSON.stringify(surface === "realtime" ? { type: "interrupt" }
        : { type: 1, target: "SendMessage", arguments: [{ $type: "interrupt" }] }));
      await until(() => modelSignal?.aborted === true);
      assert.ok(Date.now() - started < 250);
      client.send("pending next rejected");
      await until(() => client.frames.some(frame => frame.type === "error-event" || frame.$type === "error"));
      assert.equal(calls, 1);
      releaseNext(); await until(() => cleanupStarted);
      const errors = client.frames.filter(frame => frame.type === "error-event" || frame.$type === "error").length;
      client.send("pending return rejected");
      await until(() => client.frames.filter(frame => frame.type === "error-event" || frame.$type === "error").length > errors);
      assert.equal(calls, 1);
      releaseReturn(); await delay(20); client.send("recovered"); await until(() => calls === 2);
      assert.equal(client.frames.some(frame => JSON.stringify(frame).includes("discarded")), false);
    } finally {
      releaseNext(); releaseReturn(); client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("browser speech and world-agent turns contend with the authenticated realtime model slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-browser-world-"));
  const config = runtime(root); const resources = new HubResources(config.limits); const model = stalledModel();
  config.psfn.satelliteClaim = normalizeSatelliteClaimConfig({ capabilityProfile: "world-avatar", satelliteId: "world", endpointId: "world" });
  let speechCalls = 0; let lookCalls = 0; let sayCalls = 0;
  const events: unknown[] = [];
  const speech = new CompanionBrowserSpeech({ async *streamText() { speechCalls += 1; yield Buffer.from("audio"); }, async close() {} },
    event => events.push(event), resources);
  const server = new RealtimeHubServer(config, { resources, agent: model.agent, eidoverse: {
    worldName: "demo-world", agentName: "Example", look: { async look() { lookCalls += 1; return "A room."; } },
    say: { async say() { sayCalls += 1; } },
  } });
  await server.start(); const client = await connect(server, "realtime");
  try {
    client.send("hold realtime"); await until(() => model.calls.length === 1); await delay(120);
    speech.observeGateway({ type: "session.ready", capabilities: ["audio_output"] });
    speech.observeBrowser({ requestId: "test", resource: "conversation.interact" });
    speech.observeGateway({ type: "result", requestId: "test", ok: true, result: { content: "Authorized reply" } });
    await until(() => events.some(event => JSON.stringify(event).includes("error-event")));
    assert.equal(speechCalls, 0);
    await assert.rejects(server.handleEidoverseAddressedUtterance({ utteranceId: "rejected-world", userText: "rejected world" }), /provider quota/);
    assert.equal(model.calls.length, 1); assert.equal(lookCalls, 0); assert.equal(sayCalls, 0);
    model.release(); await delay(20);
    await server.handleEidoverseAddressedUtterance({ utteranceId: "recovered-world", userText: "world recovery" });
    assert.equal(model.calls.length, 2); assert.equal(lookCalls, 1); assert.equal(sayCalls, 1);
  } finally { model.release(); speech.stop(false); client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("overlapping realtime model and speech need separate slots and speech rejection cancels generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-overlap-"));
  const config = runtime(root); config.textOnlyMode = false; config.elevenlabsApiKey = "test"; config.elevenlabsVoiceId = "test";
  config.limits = { ...config.limits, providerTimeoutMs: 1000 };
  let release = (): void => {}; let signal: AbortSignal | undefined; let speechCalls = 0;
  const server = new RealtimeHubServer(config, { agent: {
    async *streamReply(input) {
      signal = input.signal;
      yield "This is enough companion text for the first spoken segment. ";
      await new Promise<void>(resolve => { release = resolve; });
      yield "discarded late text"; return "";
    }, async close() {},
  }, realtimeTts: { async *streamText() { speechCalls += 1; yield Buffer.from("must not run"); }, async close() {} } });
  await server.start(); const client = await connect(server, "realtime", true);
  try {
    client.send("overlap");
    await until(() => client.frames.some(frame => frame.type === "error-event"));
    assert.equal(signal?.aborted, true); assert.equal(speechCalls, 0);
    assert.equal(client.frames.some(frame => frame.type === "audio" || frame.type === "text"
      && ["audio-init", "audio-end"].includes(String(frame.data))), false);
    release(); await delay(20);
    assert.equal(client.frames.some(frame => JSON.stringify(frame).includes("discarded late text")), false);
    assert.equal(client.frames.some(frame => frame.type === "message" && (frame.data as { final?: boolean; role?: string }).final
      && (frame.data as { role?: string }).role === "assistant"), false);
  } finally { release(); client.socket.terminate(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime teardown aborts providers before awaiting blocked consumers and bounds ignoring subsystem close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-provider-runtime-stop-"));
  const config = runtime(root); const resources = new HubResources(config.limits); const model = stalledModel();
  const server = new RealtimeHubServer(config, { resources, agent: { ...model.agent, close: () => new Promise<void>(() => {}) } });
  await server.start(); const client = await connect(server, "voxta");
  try {
    client.send("hold runtime stop"); await until(() => model.calls.length === 1);
    const started = Date.now();
    await assert.rejects(resources.shutdown([() => new Promise<void>(() => {}), () => server.close()]), /Hub shutdown failed/);
    assert.ok(Date.now() - started < 500); assert.equal(server.address(), null);
    await assert.rejects(server.start(), /Hub has stopped/);
  } finally { model.release(); client.socket.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
});
