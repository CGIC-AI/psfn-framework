import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { HubConfig } from "../shared/env.js";
import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import {
  EIDOVERSE_SAY_MAX_TEXT_LENGTH,
  EidoverseMcpClient,
  type EidoverseMcpConfig,
} from "./eidoverse-mcp.js";
import { parseEidoversePlaceMap } from "./eidoverse-place-map.js";
import { EmbodiedSessionRegistry, type PsfnChannelContext } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { RealtimeHubServer } from "./server.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

const STUB_SERVER_PATH = fileURLToPath(
  new URL("../test-support/eidoverse-mcp-stub-server.js", import.meta.url),
);
const JOIN_TOKEN = "eidoverse-adapter-test-token";
const TOKEN_REF = "TEST_EIDOVERSE_ADAPTER_TOKEN";
const WORLD_URL = "ws://192.0.2.61:8787/world";

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  constructor(private readonly chunks: readonly string[] = ["Welcome ", "back."]) {}

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    for (const chunk of this.chunks) yield chunk;
    return this.chunks.join("");
  }

  async close(): Promise<void> {}
}

class FakeLook {
  calls = 0;

  constructor(private readonly result: string | Error) {}

  async look(): Promise<string> {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

test("world adapter attaches a stable embodied session and deduplicates addressed utterances", async () => {
  const embodiedSessions = new EmbodiedSessionRegistry("satellite.endpoint");
  const sessions = new SessionStore(60);
  const agent = new FakeAgent();
  const look = new FakeLook([
    "You are in the market.",
    "People (2):",
    "- Rowan: 1.2m north, standing",
    "- Mica: 2.8m east, walking",
    "Things (1): a brass toaster",
  ].join("\n"));
  const spoken: string[] = [];
  const config = {
    worldName: "demo-world",
    agentName: "Purrsephone",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        "demo-world": {
          placeId: "eidoverse:demo-world",
          regions: { market: "eidoverse:demo-world:market" },
        },
      },
    }),
  };
  const adapter = new EidoverseEmbodiedSessionAdapter(config, {
    embodiedSessions,
    sessions,
    agent,
    look,
    say: { say: async (text) => { spoken.push(text); } },
  });
  const sameIdentity = new EidoverseEmbodiedSessionAdapter(config, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent: new FakeAgent(),
    look: new FakeLook("Nobody else is here right now."),
    say: { say: async () => undefined },
  });

  assert.match(adapter.conversationId, /^eidoverse:[0-9a-f]{64}$/);
  assert.equal(adapter.conversationId, sameIdentity.conversationId);
  adapter.connect();

  const response = await adapter.handleAddressedUtterance({
    utteranceId: "event-17",
    userText: "Are you here?",
    region: "market",
  });

  assert.equal(response, "Welcome back.");
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]?.inputMode, "text");
  assert.equal(agent.calls[0]?.conversationId, adapter.conversationId);
  assert.equal(look.calls, 1);
  assert.deepEqual(agent.calls[0]?.history, [{ role: "user", content: "Are you here?" }]);
  assert.deepEqual(agent.calls[0]?.channel, expectedChannel(adapter.conversationId));
  assert.deepEqual(spoken, ["Welcome back."]);
  assert.equal(await adapter.handleAddressedUtterance({
    utteranceId: "event-17",
    userText: "Are you here?",
    region: "market",
  }), null);
  assert.equal(agent.calls.length, 1);
  assert.equal(look.calls, 1);
  assert.deepEqual(spoken, ["Welcome back."], "duplicate input must not repeat in-world speech");

  adapter.disconnect();
  assert.equal(embodiedSessions.getSession(adapter.conversationId), null);
  await assert.rejects(
    adapter.handleAddressedUtterance({ utteranceId: "event-18", userText: "Hello?" }),
    /not connected/,
  );

  adapter.connect();
  assert.equal(await adapter.handleAddressedUtterance({
    utteranceId: "event-17",
    userText: "Are you here?",
    region: "market",
  }), null);
  assert.equal(agent.calls.length, 1, "reconnect must not replay a consumed utterance");
  adapter.disconnect();
});

test("world adapter rejects non-world claim profiles", () => {
  assert.throws(
    () => new EidoverseEmbodiedSessionAdapter({
      worldName: "demo-world",
      agentName: "Purrsephone",
      satelliteClaim: normalizeSatelliteClaimConfig({ capabilityProfile: "voxta-avatar" }),
      placeMap: null,
    }, {
      embodiedSessions: new EmbodiedSessionRegistry(),
      sessions: new SessionStore(60),
      agent: new FakeAgent(),
      look: new FakeLook("Nobody else is here right now."),
      say: { say: async () => undefined },
    }),
    /world-avatar/,
  );
});

test("realtime hub lifecycle connects and disconnects the configured world adapter", async () => {
  const agent = new FakeAgent();
  const look = new FakeLook("People (1):\n- Rowan: 1.2m north, standing");
  const spoken: string[] = [];
  const server = new RealtimeHubServer(hubConfig(), {
    agent,
    realtimeTts: silentTts(),
    voxtaTts: null,
    voxtaStt: null,
    eidoverse: {
      worldName: "demo-world",
      agentName: "Purrsephone",
      look,
      say: { say: async (text) => { spoken.push(text); } },
    },
  });

  await server.start();
  try {
    assert.equal(await server.handleEidoverseAddressedUtterance({
      utteranceId: "event-21",
      userText: "Welcome to the market.",
      region: "market",
    }), "Welcome back.");
    assert.equal(agent.calls.length, 1);
    assert.equal(look.calls, 1);
    assert.equal(agent.calls[0]?.channel?.placeId, "eidoverse:demo-world:market");
    assert.deepEqual(spoken, ["Welcome back."]);
  } finally {
    await server.close();
  }

  await assert.rejects(
    server.handleEidoverseAddressedUtterance({
      utteranceId: "event-22",
      userText: "Are you still there?",
    }),
    /not connected/,
  );
  assert.equal(agent.calls.length, 1);
});

test("look context keeps the latest twelve notes and retains occupants", async () => {
  const agent = new FakeAgent();
  const lookLines = Array.from({ length: 15 }, (_, index) => `look line ${index + 1}`);
  lookLines.push("People (1):", "- Rowan: 1.2m north, standing");
  const adapter = new EidoverseEmbodiedSessionAdapter(adapterConfig(), {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: new FakeLook(lookLines.join("\n")),
    say: { say: async () => undefined },
  });
  adapter.connect();

  await adapter.handleAddressedUtterance({
    utteranceId: "event-bounds",
    userText: "Who is here?",
    region: "market",
  });

  assert.deepEqual(agent.calls[0]?.channel?.contextNotes, lookLines.slice(-12).map((text) => ({
    key: "eidoverse.look",
    text,
  })));
  adapter.disconnect();
});

test("look failure omits notes while retaining the statically mapped default place", async () => {
  const agent = new FakeAgent();
  let lookFailures = 0;
  const adapter = new EidoverseEmbodiedSessionAdapter(adapterConfig(), {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: new FakeLook(new Error("untrusted provider detail")),
    onLookError: () => { lookFailures += 1; },
    say: { say: async () => undefined },
  });
  adapter.connect();

  await adapter.handleAddressedUtterance({
    utteranceId: "event-look-failure",
    userText: "What is around me?",
  });

  assert.equal(lookFailures, 1);
  assert.equal(agent.calls[0]?.channel?.placeId, "eidoverse:demo-world");
  assert.equal(agent.calls[0]?.channel?.contextNotes, undefined);
  assert.equal(JSON.stringify(agent.calls[0]?.channel).includes("untrusted provider detail"), false);
  adapter.disconnect();
});

test("world adapter skips whitespace and truncates only the MCP say copy to the protocol maximum", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-say-"));
  const recordPath = path.join(directory, "say.jsonl");
  const mcp = new EidoverseMcpClient(mcpConfig("record-say", recordPath), async () => JOIN_TOKEN);
  await mcp.start();
  try {
    const whitespace = createAdapter(new FakeAgent(["  ", "\n"]), mcp);
    whitespace.adapter.connect();
    assert.equal(await whitespace.adapter.handleAddressedUtterance({
      utteranceId: "event-empty",
      userText: "Can you answer?",
    }), "");
    assert.equal(fs.existsSync(recordPath), false, "whitespace replies must not call say");
    whitespace.adapter.disconnect();

    const fullReply = "x".repeat(EIDOVERSE_SAY_MAX_TEXT_LENGTH + 5);
    const long = createAdapter(new FakeAgent(["  ", fullReply, "  "]), mcp);
    long.adapter.connect();
    assert.equal(await long.adapter.handleAddressedUtterance({
      utteranceId: "event-long",
      userText: "Please explain.",
    }), fullReply);
    const calls = readSayCalls(recordPath);
    assert.deepEqual(calls, [fullReply.slice(0, EIDOVERSE_SAY_MAX_TEXT_LENGTH)]);
    assert.deepEqual(long.sessions.getHistory(long.adapter.conversationId), [
      { role: "user", content: "Please explain." },
      { role: "assistant", content: fullReply },
    ], "the completed PSFN turn retains the full assistant reply");
    long.adapter.disconnect();
  } finally {
    await mcp.close();
  }
});

test("world adapter logs one sanitized MCP say failure without retrying or failing the completed turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-say-failure-"));
  const recordPath = path.join(directory, "say.jsonl");
  const mcp = new EidoverseMcpClient(mcpConfig("say-error", recordPath), async () => JOIN_TOKEN);
  const warnings: string[] = [];
  const agent = new FakeAgent(["Still here."]);
  const embodiedSessions = new EmbodiedSessionRegistry("satellite.endpoint");
  const sessions = new SessionStore(60);
  const adapter = new EidoverseEmbodiedSessionAdapter(worldConfig(), {
    embodiedSessions,
    sessions,
    agent,
    look: new FakeLook("Nobody else is here right now."),
    say: mcp,
    logger: { warn: (message) => warnings.push(message) },
  });

  await mcp.start();
  adapter.connect();
  try {
    assert.equal(await adapter.handleAddressedUtterance({
      utteranceId: "event-say-failure",
      userText: "Are you there?",
    }), "Still here.");
    assert.deepEqual(readSayCalls(recordPath), ["Still here."], "say failure must not retry");
    assert.deepEqual(warnings, ["Eidoverse in-world say failed"]);
    assert.doesNotMatch(warnings.join("\n"), new RegExp(`${JOIN_TOKEN}|${TOKEN_REF}|${WORLD_URL}`));
    assert.deepEqual(sessions.getHistory(adapter.conversationId), [
      { role: "user", content: "Are you there?" },
      { role: "assistant", content: "Still here." },
    ]);
  } finally {
    adapter.disconnect();
    await mcp.close();
  }
});

function createAdapter(agent: FakeAgent, say: EidoverseMcpClient): {
  adapter: EidoverseEmbodiedSessionAdapter;
  sessions: SessionStore;
} {
  const sessions = new SessionStore(60);
  return {
    adapter: new EidoverseEmbodiedSessionAdapter(worldConfig(), {
      embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
      sessions,
      agent,
      look: new FakeLook("Nobody else is here right now."),
      say,
    }),
    sessions,
  };
}

function worldConfig() {
  return {
    worldName: "demo-world",
    agentName: "Purrsephone",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: null,
  };
}

function mcpConfig(mode: string, recordPath: string): EidoverseMcpConfig {
  return {
    command: process.execPath,
    args: [STUB_SERVER_PATH, mode, recordPath],
    worldUrl: WORLD_URL,
    tokenRef: TOKEN_REF,
    worldName: "demo-world",
    agentName: "Purrsephone",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    pendingPingsPollIntervalMs: 1_000,
    ambientSayDebounceMs: 10_000,
  };
}

function readSayCalls(filePath: string): string[] {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
}

function expectedChannel(conversationId: string): PsfnChannelContext {
  return {
    sessionId: conversationId,
    channelType: "satellite.endpoint",
    channelId: `satellite.endpoint:${conversationId}`,
    sourceSatelliteId: "eidoverse-world",
    sourceSatelliteName: "Eidoverse World Avatar",
    claimIdentity: {
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      claimType: "world-avatar",
      displayName: "Eidoverse World Avatar",
    },
    activeSatellites: [{
      id: "eidoverse-world",
      name: "Eidoverse World Avatar",
      transport: "mcp",
      capabilities: {
        input: ["text", "vision_upload"],
        output: ["text", "subtitle", "action", "emotion"],
        control: ["presence", "session_attach"],
        safety: ["action_allowlist", "confirmation_required"],
      },
    }],
    placeId: "eidoverse:demo-world:market",
    contextNotes: [
      { key: "eidoverse.look", text: "You are in the market." },
      { key: "eidoverse.look", text: "People (2):" },
      { key: "eidoverse.look", text: "- Rowan: 1.2m north, standing" },
      { key: "eidoverse.look", text: "- Mica: 2.8m east, walking" },
      { key: "eidoverse.look", text: "Things (1): a brass toaster" },
    ],
  };
}

function adapterConfig() {
  return {
    worldName: "demo-world",
    agentName: "Purrsephone",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        "demo-world": {
          placeId: "eidoverse:demo-world",
          regions: { market: "eidoverse:demo-world:market" },
        },
      },
    }),
  };
}

function hubConfig(): HubConfig {
  const satelliteClaim = normalizeSatelliteClaimConfig({
    capabilityProfile: "world-avatar",
    satelliteId: "eidoverse-world",
    endpointId: "eidoverse-avatar",
    displayName: "Eidoverse World Avatar",
  });
  return {
    textOnlyMode: true,
    bindHost: "127.0.0.1",
    port: 0,
    deepgramApiKey: null,
    elevenlabsApiKey: null,
    elevenlabsVoiceId: null,
    elevenlabsModelId: "eleven_flash_v2_5",
    artifactsRoot: ".artifacts/eidoverse-adapter-test",
    psfn: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "psfn",
      channelType: "satellite.endpoint",
      satelliteClaim,
      voiceReplyDeadlineMs: 8_000,
      voiceAttemptTimeoutMs: 6_000,
      textReplyDeadlineMs: 80_000,
      textAttemptTimeoutMs: 75_000,
    },
    companion: null,
    homeAssistant: null,
    control: null,
    deviceRegistry: null,
    eidoversePlaceMap: parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        "demo-world": {
          placeId: "eidoverse:demo-world",
          regions: { market: "eidoverse:demo-world:market" },
        },
      },
    }),
    voxta: {
      enabled: false,
      satelliteId: "voxta",
      satelliteName: "Voxta",
      sessionId: null,
      chatId: null,
      assistantId: "assistant",
      assistantName: "Assistant",
      userId: "user",
      userName: "User",
      appLabel: "Test",
      clientVersion: "1",
      publicBaseUrl: null,
      audioFolder: null,
      sttStreamEnabled: false,
      visionCaptureTimeoutMs: 1_000,
      actionAllowlist: [],
    },
    sessionTtlSeconds: 60,
  };
}

function silentTts(): StreamingTtsAdapter {
  return {
    async *streamText(): AsyncGenerator<Buffer, void, void> {},
    async close(): Promise<void> {},
  };
}
