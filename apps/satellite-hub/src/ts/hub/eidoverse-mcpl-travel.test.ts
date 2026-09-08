import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import { createHubDeviceAssertionIssuer } from "./device-assertion.js";
import { createHubDeviceRegistryAuthority, type HubDeviceRegistry } from "./device-registry.js";
import {
  EidoverseEmbodiedSessionAdapter,
  type EidoverseTravelPort,
} from "./eidoverse-adapter.js";
import { parseEidoversePlaceMap } from "./eidoverse-place-map.js";
import { EmbodiedSessionRegistry, type PsfnChannelContext } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { RealtimeHubServer } from "./server.js";
import { SessionStore } from "./session-store.js";
import type { HubConfig } from "../shared/env.js";
import type { HubToClientMessage } from "../shared/protocol.js";

const PLACE_MAP = parseEidoversePlaceMap({
  schemaVersion: 1,
  worlds: {
    commons: { placeId: "eidoverse:commons" },
    annex: { placeId: "eidoverse:annex" },
  },
});

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

class RecordingAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "ok";
    return "ok";
  }

  async close(): Promise<void> {}
}

class RecordingDoor implements EidoverseTravelPort {
  readonly requested: string[] = [];

  constructor(private readonly refuse = false) {}

  async look(): Promise<string> {
    return "An atrium.";
  }

  async say(): Promise<void> {}

  async travel(world: string): Promise<string> {
    this.requested.push(world);
    if (this.refuse) throw new Error("Eidoverse MCPL travel request failed");
    return `Arrived in "${world}" (attachment 2).`;
  }
}

function adapter(door: RecordingDoor | null, agent: RecordingAgent, warnings: string[]) {
  return new EidoverseEmbodiedSessionAdapter({
    worldName: "commons",
    agentName: "Companion",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: PLACE_MAP,
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: door ?? { look: async () => "An atrium." },
    say: { say: async () => undefined },
    ...(door ? { travel: door } : {}),
    logger: { warn: (message) => warnings.push(message) },
  });
}

async function placeIdOfNextTurn(
  session: EidoverseEmbodiedSessionAdapter,
  agent: RecordingAgent,
  utteranceId: string,
): Promise<PsfnChannelContext["placeId"]> {
  await session.handleAddressedUtterance({ utteranceId, userText: "Quill: hello" });
  return agent.calls.at(-1)?.channel?.placeId;
}

test("a mapped world changes the placeId every later turn carries", async () => {
  const agent = new RecordingAgent();
  const door = new RecordingDoor();
  const warnings: string[] = [];
  const session = adapter(door, agent, warnings);
  session.connect();
  try {
    assert.equal(await placeIdOfNextTurn(session, agent, "before"), "eidoverse:commons");
    const outcome = await session.travelTo("annex");
    assert.deepEqual(outcome, { accepted: true, world: "annex", placeId: "eidoverse:annex" });
    assert.deepEqual(door.requested, ["annex"]);
    assert.equal(await placeIdOfNextTurn(session, agent, "after"), "eidoverse:annex");
    const notes = agent.calls.at(-1)?.channel?.contextNotes ?? [];
    assert.equal(
      notes.some((note) => note.key === "eidoverse.travel" && note.text.includes("annex")),
      true,
      "the turn should say where the body just arrived",
    );
  } finally {
    session.disconnect();
  }
});

test("an unmapped world stays put and never fabricates a place", async () => {
  const agent = new RecordingAgent();
  const door = new RecordingDoor();
  const warnings: string[] = [];
  const session = adapter(door, agent, warnings);
  session.connect();
  try {
    await placeIdOfNextTurn(session, agent, "before");
    const outcome = await session.travelTo("uncharted");
    assert.deepEqual(outcome, { accepted: false, world: "commons", reason: "unmapped_world" });
    assert.deepEqual(door.requested, [], "an unmapped destination never reaches the wire");
    assert.equal(await placeIdOfNextTurn(session, agent, "after"), "eidoverse:commons");
    assert.deepEqual(warnings, ["Eidoverse travel refused: unmapped_world"]);
  } finally {
    session.disconnect();
  }
});

test("a door that refuses or times out leaves the placeId exactly where it was", async () => {
  const agent = new RecordingAgent();
  const door = new RecordingDoor(true);
  const warnings: string[] = [];
  const session = adapter(door, agent, warnings);
  session.connect();
  try {
    const outcome = await session.travelTo("annex");
    assert.deepEqual(outcome, { accepted: false, world: "commons", reason: "refused" });
    assert.equal(await placeIdOfNextTurn(session, agent, "after"), "eidoverse:commons");
    assert.deepEqual(warnings, ["Eidoverse travel refused: refused"]);
  } finally {
    session.disconnect();
  }
});

test("travel is unavailable on a transport that cannot move, and refuses a malformed world", async () => {
  const agent = new RecordingAgent();
  const warnings: string[] = [];
  const pollOnly = adapter(null, agent, warnings);
  pollOnly.connect();
  try {
    assert.deepEqual(await pollOnly.travelTo("annex"), {
      accepted: false,
      world: "commons",
      reason: "unavailable",
    });
    assert.deepEqual(await pollOnly.travelTo("Not A World"), {
      accepted: false,
      world: "commons",
      reason: "invalid_world",
    });
  } finally {
    pollOnly.disconnect();
  }
});

test("travelling to the world already occupied is a no-op that keeps the place", async () => {
  const agent = new RecordingAgent();
  const door = new RecordingDoor();
  const session = adapter(door, agent, []);
  session.connect();
  try {
    assert.deepEqual(await session.travelTo("commons"), {
      accepted: true,
      world: "commons",
      placeId: "eidoverse:commons",
    });
    assert.deepEqual(door.requested, []);
  } finally {
    session.disconnect();
  }
});

// ── The companion-facing command surface ────────────────────────────────────

const DEVICE_CREDENTIAL = "world-avatar-secret";
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

function registry(control: Array<"world_travel">): HubDeviceRegistry {
  return {
    schemaVersion: 1,
    devices: [{
      deviceId: "avatar-device",
      deviceName: "Avatar Device",
      satelliteId: "eidoverse-world",
      satelliteName: "Eidoverse World Avatar",
      endpointId: "eidoverse-avatar",
      claimType: "world-avatar",
      credentialSha256: createHash("sha256").update(DEVICE_CREDENTIAL).digest("hex"),
      enrollmentVersion: 1,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "office",
      homeAssistantEntityIds: [],
      maxCapabilities: {
        input: ["text"],
        output: ["text"],
        control,
        safety: ["local_only"],
      },
    }],
  };
}

function hubConfig(control: Array<"world_travel">): HubConfig {
  return {
    textOnlyMode: true,
    bindHost: "127.0.0.1",
    port: 0,
    deepgramApiKey: null,
    elevenlabsApiKey: null,
    elevenlabsVoiceId: null,
    elevenlabsModelId: "eleven_flash_v2_5",
    artifactsRoot: ".artifacts/test-eidoverse-travel",
    psfn: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "psfn",
      channelType: "satellite.endpoint",
      deviceAssertionIssuer: DEVICE_ASSERTION_ISSUER,
      satelliteClaim: normalizeSatelliteClaimConfig({
        capabilityProfile: "world-avatar",
        satelliteId: "eidoverse-world",
        endpointId: "eidoverse-avatar",
        displayName: "Eidoverse World Avatar",
      }),
      voiceReplyDeadlineMs: 8_000,
      voiceAttemptTimeoutMs: 6_000,
      textReplyDeadlineMs: 80_000,
      textAttemptTimeoutMs: 75_000,
    },
    companion: null,
    homeAssistant: null,
    control: null,
    deviceRegistry: createHubDeviceRegistryAuthority(() => registry(control)),
    eidoversePlaceMap: PLACE_MAP,
    location: null,
    voxta: {
      enabled: false, satelliteId: "voxta", satelliteName: "Voxta", sessionId: null,
      chatId: null, assistantId: "assistant", assistantName: "Assistant", userId: "user",
      userName: "User", appLabel: "Test", clientVersion: "1", publicBaseUrl: null,
      audioFolder: null, sttStreamEnabled: false, visionCaptureTimeoutMs: 1_000,
      actionAllowlist: [],
    },
    sessionTtlSeconds: 60,
  };
}

async function travelOverTheWire(input: {
  control: Array<"world_travel">;
  world: string;
  door?: RecordingDoor | null;
}): Promise<{ result: HubToClientMessage | undefined; door: RecordingDoor | null }> {
  const door = input.door === undefined ? new RecordingDoor() : input.door;
  const server = new RealtimeHubServer(hubConfig(input.control), {
    agent: new RecordingAgent(),
    eidoverse: door
      ? {
        worldName: "commons",
        agentName: "Companion",
        look: door,
        say: door,
        travel: door,
      }
      : null,
  });
  await server.start();
  const messages: HubToClientMessage[] = [];
  let socket: WebSocket | null = null;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as HubToClientMessage));
    await new Promise<void>((resolve) => socket?.once("open", resolve));
    // The satellite asks for exactly what its registry entry allows: a request
    // for more is refused at hello, which is a different gate than this test.
    socket.send(JSON.stringify({
      type: "hello",
      deviceId: "avatar-device",
      deviceName: "Avatar Device",
      credential: DEVICE_CREDENTIAL,
      capabilities: { input: ["text"], output: ["text"], control: input.control, safety: [] },
    }));
    await waitFor(() => messages.some((message) => message.type === "hello.ack"));
    socket.send(JSON.stringify({ type: "world.travel", world: input.world }));
    await waitFor(() => messages.some((message) => message.type === "world.travel.result"));
  } finally {
    if (socket) {
      const closing = socket;
      closing.close();
      await new Promise<void>((resolve) => closing.once("close", () => resolve()));
    }
    await server.close();
  }
  return {
    result: messages.find((message) => message.type === "world.travel.result"),
    door,
  };
}

test("an authorized satellite can move the emanation and is told the new place", async () => {
  const { result, door } = await travelOverTheWire({ control: ["world_travel"], world: "annex" });
  assert.deepEqual(result, {
    type: "world.travel.result",
    accepted: true,
    world: "annex",
    placeId: "eidoverse:annex",
  });
  assert.deepEqual(door?.requested, ["annex"]);
});

test("a satellite without the registry-granted capability cannot move the emanation", async () => {
  const { result, door } = await travelOverTheWire({ control: [], world: "annex" });
  assert.deepEqual(result, {
    type: "world.travel.result",
    accepted: false,
    world: "annex",
    reason: "capability_denied",
  });
  assert.deepEqual(door?.requested, [], "an unauthorized request never reaches the door");
});

test("a Hub with no Eidoverse emanation refuses the command outright", async () => {
  const { result } = await travelOverTheWire({
    control: ["world_travel"],
    world: "annex",
    door: null,
  });
  assert.deepEqual(result, {
    type: "world.travel.result",
    accepted: false,
    world: "annex",
    reason: "not_configured",
  });
});

test("an unmapped destination is refused in the Hub's own vocabulary", async () => {
  const { result, door } = await travelOverTheWire({ control: ["world_travel"], world: "uncharted" });
  assert.deepEqual(result, {
    type: "world.travel.result",
    accepted: false,
    world: "commons",
    reason: "unmapped_world",
  });
  assert.deepEqual(door?.requested, []);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for a hub message");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
