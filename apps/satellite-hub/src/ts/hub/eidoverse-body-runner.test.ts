import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EidoverseEmbodiedSessionAdapter } from "./eidoverse-adapter.js";
import {
  EIDOVERSE_BODY_ACTION_NAMES,
  EidoverseBodyActionRejectedError,
  EidoverseBodyRunner,
  claimGrantsEidoverseBodyActions,
  loadEidoverseBodyRunnerConfig,
  parseEidoverseBodyAction,
  type EidoverseBodyTools,
} from "./eidoverse-body-runner.js";
import { EidoverseMcpClient, type EidoverseMcpConfig } from "./eidoverse-mcp.js";
import { EmbodiedSessionRegistry } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

const STUB_SERVER_PATH = fileURLToPath(
  new URL("../test-support/eidoverse-mcp-stub-server.js", import.meta.url),
);
const JOIN_TOKEN = "eidoverse-body-test-token";
const TOKEN_REF = "TEST_EIDOVERSE_BODY_TOKEN";
const WORLD_URL = "ws://192.0.2.61:8787/world";
const WALK_TIMEOUT_MS = 2_000;
const MAX_PENDING_NOTES = 4;

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Understood.";
    return "Understood.";
  }

  async close(): Promise<void> {}
}

/** A walk that only resolves when the test releases it, mirroring the door's
 *  ability to block for its full walk budget. */
class GatedTools implements EidoverseBodyTools {
  readonly walkCalls: Array<{ x: number; z: number; run: boolean; timeoutMs: number }> = [];
  private release: (() => void) | null = null;

  async walkTo(x: number, z: number, run: boolean, timeoutMs: number): Promise<string> {
    this.walkCalls.push({ x, z, run, timeoutMs });
    await new Promise<void>((resolve) => { this.release = resolve; });
    return "arrived at (12.0, -4.5)";
  }

  async face(): Promise<string> {
    return "facing";
  }

  async stop(): Promise<string> {
    return "stopped";
  }

  releaseWalk(): void {
    this.release?.();
    this.release = null;
  }
}

class RecordingTools implements EidoverseBodyTools {
  readonly walkCalls: Array<{ x: number; z: number; run: boolean; timeoutMs: number }> = [];
  readonly faceCalls: string[] = [];
  stopCalls = 0;

  constructor(private readonly walkReply: string | Error = "arrived at (12.0, -4.5)") {}

  async walkTo(x: number, z: number, run: boolean, timeoutMs: number): Promise<string> {
    this.walkCalls.push({ x, z, run, timeoutMs });
    if (this.walkReply instanceof Error) throw this.walkReply;
    return this.walkReply;
  }

  async face(target: string): Promise<string> {
    this.faceCalls.push(target);
    return "facing";
  }

  async stop(): Promise<string> {
    this.stopCalls += 1;
    return "stopped";
  }
}

test("body action allowlist rejects world-editing verbs and malformed locomotion arguments", () => {
  assert.deepEqual(
    [...EIDOVERSE_BODY_ACTION_NAMES],
    [
      "walk_to", "face", "stop", "emote", "posture", "whisper",
      "take_off", "climb_to", "glide_to", "land_at", "fold_wings", "unfold_wings", "flight_status",
      "play_clip",
      "spawn", "remove", "set_avatar",
    ],
  );
  // Named clip library (ae7c9): a bounded name, never bones or keyframes.
  assert.deepEqual(parseEidoverseBodyAction("play_clip", { name: "cheer" }), { name: "play_clip", clip: "cheer" });
  assert.throws(() => parseEidoverseBodyAction("play_clip", { name: "../etc" }), EidoverseBodyActionRejectedError);
  assert.throws(() => parseEidoverseBodyAction("play_clip", {}), EidoverseBodyActionRejectedError);
  // Flight family (jbvwz): bounded like every other verb; raw-bone pose and
  // animate stay outside the allowlist.
  assert.deepEqual(parseEidoverseBodyAction("take_off", {}), { name: "take_off" });
  assert.deepEqual(parseEidoverseBodyAction("flight_status", undefined), { name: "flight_status" });
  assert.deepEqual(parseEidoverseBodyAction("climb_to", { altitude: 12.5 }), { name: "climb_to", altitude: 12.5 });
  assert.throws(() => parseEidoverseBodyAction("climb_to", { altitude: 0 }), EidoverseBodyActionRejectedError);
  assert.throws(() => parseEidoverseBodyAction("climb_to", { altitude: 5000 }), EidoverseBodyActionRejectedError);
  assert.deepEqual(parseEidoverseBodyAction("glide_to", { x: 3, z: -4 }), { name: "glide_to", x: 3, z: -4 });
  assert.deepEqual(parseEidoverseBodyAction("land_at", { x: 1, z: 2 }), { name: "land_at", x: 1, z: 2 });
  assert.throws(() => parseEidoverseBodyAction("land_at", { x: 1 }), EidoverseBodyActionRejectedError);
  for (const raw of ["pose", "animate", "clear_pose", "reach", "ragdoll"]) {
    assert.throws(() => parseEidoverseBodyAction(raw, { bones: {} }), EidoverseBodyActionRejectedError, `${raw} stays outside the allowlist`);
  }
  // Raw world editing, placement of arbitrary entities, moderation, vision
  // and speech never go through the body runner.
  for (const forbidden of ["place", "world_verb", "moderate", "kick", "ban", "terrain", "snapshot", "say"]) {
    assert.throws(
      () => parseEidoverseBodyAction(forbidden, { x: 1, z: 2 }),
      EidoverseBodyActionRejectedError,
      `${forbidden} must not be reachable through the body runner`,
    );
  }
  assert.throws(() => parseEidoverseBodyAction("walk_to", { x: 1 }), EidoverseBodyActionRejectedError);
  assert.throws(
    () => parseEidoverseBodyAction("walk_to", { x: Number.NaN, z: 0 }),
    EidoverseBodyActionRejectedError,
  );
  assert.throws(
    () => parseEidoverseBodyAction("walk_to", { x: 1, z: 2, run: "yes" }),
    EidoverseBodyActionRejectedError,
  );
  assert.throws(() => parseEidoverseBodyAction("face", { target: "  " }), EidoverseBodyActionRejectedError);
  assert.deepEqual(parseEidoverseBodyAction("walk_to", { x: 1.5, z: -2, run: true }), {
    name: "walk_to",
    x: 1.5,
    z: -2,
    run: true,
  });
  assert.deepEqual(parseEidoverseBodyAction("stop", undefined), { name: "stop" });
});

test("body runner records content-free outcomes and drains them exactly once", async () => {
  const tools = new RecordingTools();
  const runner = new EidoverseBodyRunner(
    { walkTimeoutMs: WALK_TIMEOUT_MS, maxPendingNotes: MAX_PENDING_NOTES },
    tools,
    { logger: { warn: () => undefined } },
  );
  runner.submit(parseEidoverseBodyAction("walk_to", { x: 12, z: -4.5, run: true }));
  runner.submit(parseEidoverseBodyAction("face", { target: "rowan" }));
  runner.submit(parseEidoverseBodyAction("stop", {}));
  await runner.close();

  assert.deepEqual(tools.walkCalls, [{ x: 12, z: -4.5, run: true, timeoutMs: WALK_TIMEOUT_MS }]);
  assert.deepEqual(tools.faceCalls, ["rowan"]);
  assert.equal(tools.stopCalls, 1);

  const notes = runner.drainNotes();
  assert.equal(notes.length, 3);
  assert.equal(notes.every((note) => note.key === "eidoverse.body"), true);
  const serialized = JSON.stringify(notes);
  assert.equal(serialized.includes("12"), false, "world coordinates must never reach a context note");
  assert.equal(serialized.includes("4.5"), false);
  assert.equal(serialized.includes("arrived at"), false, "the door's own reply text is never forwarded");
  assert.match(notes[0]?.text ?? "", /arrived/u);
  assert.deepEqual(runner.drainNotes(), [], "notes are consumed by the turn that reads them");
});

test("body runner bounds its pending note buffer and fails closed on door errors", async () => {
  const tools = new RecordingTools(new Error("door refused"));
  const warnings: string[] = [];
  const runner = new EidoverseBodyRunner(
    { walkTimeoutMs: WALK_TIMEOUT_MS, maxPendingNotes: 2 },
    tools,
    { logger: { warn: (message) => warnings.push(message) } },
  );
  for (let index = 0; index < 5; index += 1) {
    runner.submit(parseEidoverseBodyAction("walk_to", { x: index, z: index }));
  }
  await runner.close();

  const notes = runner.drainNotes();
  assert.equal(notes.length, 2, "the outcome buffer stays bounded");
  assert.equal(
    notes.every((note) => /could not be carried out/u.test(note.text)),
    true,
    "a failed action never claims movement",
  );
  assert.equal(warnings.length, 5);
  assert.equal(warnings.every((message) => !message.includes(JOIN_TOKEN)), true);
  assert.throws(
    () => runner.submit(parseEidoverseBodyAction("stop", {})),
    EidoverseBodyActionRejectedError,
    "a closed runner accepts nothing",
  );
});

test("capability profiles without the action allowlist never get a body runner", () => {
  assert.equal(
    claimGrantsEidoverseBodyActions(normalizeSatelliteClaimConfig({ capabilityProfile: "world-avatar" })),
    true,
  );
  for (const profile of ["voice-only", "text-only", "vision-capable", "telemetry-only"] as const) {
    assert.equal(
      claimGrantsEidoverseBodyActions(normalizeSatelliteClaimConfig({ capabilityProfile: profile })),
      false,
      `${profile} must not reach in-world locomotion`,
    );
  }
});

test("body runner config reads bounded tuning from the environment", () => {
  assert.deepEqual(loadEidoverseBodyRunnerConfig({}), {
    walkTimeoutMs: 95_000,
    maxPendingNotes: 4,
  });
  assert.deepEqual(
    loadEidoverseBodyRunnerConfig({
      EIDOVERSE_BODY_WALK_TIMEOUT_MS: "30000",
      EIDOVERSE_BODY_MAX_PENDING_NOTES: "2",
    }),
    { walkTimeoutMs: 30_000, maxPendingNotes: 2 },
  );
  assert.throws(() => loadEidoverseBodyRunnerConfig({ EIDOVERSE_BODY_WALK_TIMEOUT_MS: "0" }));
  assert.throws(() => loadEidoverseBodyRunnerConfig({ EIDOVERSE_BODY_MAX_PENDING_NOTES: "-1" }));
});

test("the adapter keeps locomotion off the turn and surfaces only a content-free note next turn", async () => {
  const tools = new GatedTools();
  const runner = new EidoverseBodyRunner(
    { walkTimeoutMs: WALK_TIMEOUT_MS, maxPendingNotes: MAX_PENDING_NOTES },
    tools,
    { logger: { warn: () => undefined } },
  );
  const agent = new FakeAgent();
  const sessions = new SessionStore(60);
  const adapter = new EidoverseEmbodiedSessionAdapter({
    worldName: "demo-world",
    agentName: "Aster Example",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: null,
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions,
    agent,
    look: { look: async () => "Nobody else is here right now." },
    say: { say: async () => undefined },
    body: runner,
  });
  adapter.connect();

  adapter.submitBodyAction("walk_to", { x: 12, z: -4.5 });
  await adapter.handleAddressedUtterance({ utteranceId: "turn-1", userText: "Where are you going?" });
  const firstNotes = JSON.stringify(agent.calls[0]?.channel?.contextNotes ?? []);
  assert.equal(
    firstNotes.includes("eidoverse.body"),
    false,
    "the walk must not be awaited or reported on the turn that requested it",
  );
  assert.deepEqual(tools.walkCalls, [{ x: 12, z: -4.5, run: false, timeoutMs: WALK_TIMEOUT_MS }]);

  tools.releaseWalk();
  await runner.close();
  await adapter.handleAddressedUtterance({ utteranceId: "turn-2", userText: "Are you there yet?" });
  const secondNotes = agent.calls[1]?.channel?.contextNotes ?? [];
  assert.equal(secondNotes.some((note) => note.key === "eidoverse.body"), true);
  const serialized = JSON.stringify(secondNotes);
  assert.equal(serialized.includes("12"), false, "no pose or coordinate data reaches the agent adapter");
  assert.equal(serialized.includes("4.5"), false);
  assert.equal(serialized.includes("arrived at"), false);
  assert.equal(
    "visionCaptureImages" in (agent.calls[1]?.channel ?? {}),
    false,
    "locomotion never attaches image or pose payloads to the turn",
  );

  await adapter.handleAddressedUtterance({ utteranceId: "turn-3", userText: "And now?" });
  assert.equal(
    (agent.calls[2]?.channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.body"),
    false,
    "a drained outcome is not repeated on later turns",
  );
  adapter.disconnect();
});

test("a profile without a body runner rejects every body action request", () => {
  const adapter = new EidoverseEmbodiedSessionAdapter({
    worldName: "demo-world",
    agentName: "Aster Example",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: null,
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent: new FakeAgent(),
    look: { look: async () => "" },
    say: { say: async () => undefined },
  });
  assert.throws(() => adapter.submitBodyAction("walk_to", { x: 1, z: 1 }), /not enabled/u);
});

test("the MCP client records walk_to arguments and shutdown cancels an in-flight walk without crashing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-body-"));
  const recordPath = path.join(directory, "body.jsonl");
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  const mcp = new EidoverseMcpClient(mcpConfig("body-slow", recordPath), async () => JOIN_TOKEN);
  const warnings: string[] = [];
  const runner = new EidoverseBodyRunner(
    { walkTimeoutMs: WALK_TIMEOUT_MS, maxPendingNotes: MAX_PENDING_NOTES },
    mcp,
    { logger: { warn: (message) => warnings.push(message) } },
  );
  try {
    await mcp.start();
    runner.submit(parseEidoverseBodyAction("walk_to", { x: 12, z: -4.5, run: true }));
    await waitForRecord(recordPath);
    assert.deepEqual(readBodyCalls(recordPath), [
      { name: "walk_to", args: { x: 12, z: -4.5, run: true } },
    ], "the stub body records the exact allowlisted walk arguments");
    await Promise.all([mcp.close(), runner.close()]);
  } finally {
    await mcp.close();
    process.off("unhandledRejection", onRejection);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  assert.deepEqual(rejections, [], "an interrupted walk must not become an unhandled rejection");
  const notes = runner.drainNotes();
  assert.equal(notes.length, 1);
  assert.match(notes[0]?.text ?? "", /could not be carried out|did not finish/u);
  assert.equal(
    warnings.every((message) => !message.includes(JOIN_TOKEN) && !message.includes(WORLD_URL)),
    true,
    "body failures never log credentials or the world URL",
  );
});

function mcpConfig(mode: string, recordPath: string): EidoverseMcpConfig {
  return {
    command: process.execPath,
    args: [STUB_SERVER_PATH, mode, recordPath],
    worldUrl: WORLD_URL,
    tokenRef: TOKEN_REF,
    worldName: "demo-world",
    agentName: "Aster Example",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 1_000,
    pendingPingsPollIntervalMs: 1_000,
    ambientSayDebounceMs: 10_000,
  };
}

function readBodyCalls(filePath: string): unknown[] {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function waitForRecord(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").trim().length > 0) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error("the stub body never recorded a walk_to call");
}
