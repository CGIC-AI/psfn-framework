import assert from "node:assert/strict";
import test from "node:test";

import type { HubConfig } from "../shared/env.js";
import type { StreamingTtsAdapter } from "./elevenlabs-stream.js";
import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import { parseEidoversePlaceMap } from "./eidoverse-place-map.js";
import { EmbodiedSessionRegistry, type PsfnChannelContext } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { RealtimeHubServer } from "./server.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Welcome ";
    yield "back.";
    return "Welcome back.";
  }

  async close(): Promise<void> {}
}

test("world adapter attaches a stable embodied session and deduplicates addressed utterances", async () => {
  const embodiedSessions = new EmbodiedSessionRegistry("satellite.endpoint");
  const sessions = new SessionStore(60);
  const agent = new FakeAgent();
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
  });
  const sameIdentity = new EidoverseEmbodiedSessionAdapter(config, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent: new FakeAgent(),
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
  assert.deepEqual(agent.calls[0]?.history, [{ role: "user", content: "Are you here?" }]);
  assert.deepEqual(agent.calls[0]?.channel, expectedChannel(adapter.conversationId));
  assert.equal(await adapter.handleAddressedUtterance({
    utteranceId: "event-17",
    userText: "Are you here?",
    region: "market",
  }), null);
  assert.equal(agent.calls.length, 1);

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
    }),
    /world-avatar/,
  );
});

test("realtime hub lifecycle connects and disconnects the configured world adapter", async () => {
  const agent = new FakeAgent();
  const server = new RealtimeHubServer(hubConfig(), {
    agent,
    realtimeTts: silentTts(),
    voxtaTts: null,
    voxtaStt: null,
    eidoverse: { worldName: "demo-world", agentName: "Purrsephone" },
  });

  await server.start();
  try {
    assert.equal(await server.handleEidoverseAddressedUtterance({
      utteranceId: "event-21",
      userText: "Welcome to the market.",
      region: "market",
    }), "Welcome back.");
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0]?.channel?.placeId, "eidoverse:demo-world:market");
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
        output: ["text", "subtitle", "action"],
        control: ["presence", "session_attach"],
        safety: ["action_allowlist", "confirmation_required"],
      },
    }],
    placeId: "eidoverse:demo-world:market",
    contextNotes: [{
      key: "eidoverse.world",
      text: "Avatar \"Purrsephone\" is in Eidoverse world \"demo-world\", region \"market\".",
    }],
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
