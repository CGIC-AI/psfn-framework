import assert from "node:assert/strict";
import test from "node:test";

import { EidoverseEmbodiedSessionAdapter, type EidoverseTravelPort } from "./eidoverse-adapter.js";
import {
  EidoverseBodyRunner,
  isEidoverseWorldEditAction,
  parseEidoverseBodyAction,
  type EidoverseBodyTools,
} from "./eidoverse-body-runner.js";
import { parseEidoversePlaceMap } from "./eidoverse-place-map.js";
import { EmbodiedSessionRegistry } from "./embodied-session.js";
import type { FrameworkAgentAdapter } from "./framework-agent.js";
import { normalizeSatelliteClaimConfig } from "./satellite-claim.js";
import { SessionStore } from "./session-store.js";

type ReplyInput = Parameters<FrameworkAgentAdapter["streamReply"]>[0];

class FakeAgent implements FrameworkAgentAdapter {
  readonly calls: ReplyInput[] = [];

  async *streamReply(input: ReplyInput): AsyncGenerator<string, string, void> {
    this.calls.push(input);
    yield "Coming.";
    return "Coming.";
  }

  async close(): Promise<void> {}
}

/** A door whose walk arrives where it was sent and whose look tracks the body. */
class FakeDoor implements EidoverseBodyTools, EidoverseTravelPort {
  x = 0;
  z = 0;
  world = "commons";
  readonly walks: Array<{ x: number; z: number }> = [];
  readonly verbs: string[] = [];
  readonly travels: string[] = [];
  walkDelayMs = 0;

  async look(): Promise<string> {
    return [
      `You are "artie" in world "${this.world}" at (${this.x.toFixed(1)}, ${this.z.toFixed(1)}), ground height 0.00m, facing S.`,
      "People (1):",
      "  - visitor: 5.0m E at (5.0, 0.0), standing",
      "No placed things yet.",
    ].join("\n");
  }

  async walkTo(x: number, z: number): Promise<string> {
    this.walks.push({ x, z });
    if (this.walkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.walkDelayMs));
    this.x = x;
    this.z = z;
    return `arrived at (${x.toFixed(1)}, ${z.toFixed(1)})`;
  }

  async face(target: string): Promise<string> { this.verbs.push(`face ${target}`); return "facing"; }
  async stop(): Promise<string> { this.verbs.push("stop"); return "stopped"; }
  async emote(name: string): Promise<string> { this.verbs.push(`emote ${name}`); return `you ${name}`; }
  async posture(kind: string): Promise<string> { this.verbs.push(`posture ${kind}`); return `you ${kind}`; }
  async spawn(args: { query?: string }): Promise<string> { this.verbs.push(`spawn ${args.query}`); return "spawned [ab12] bench at (1.0, 2.0)"; }
  async remove(id: string): Promise<string> { this.verbs.push(`remove ${id}`); return `removed ${id}`; }
  async setAvatar(avatar: string): Promise<string> { this.verbs.push(`avatar ${avatar}`); return `avatar set to ${avatar}`; }

  async travel(world: string): Promise<string> {
    this.travels.push(world);
    this.world = world;
    this.x = 0;
    this.z = 0;
    return `Arrived in "${world}"`;
  }
}

function adapterWith(door: FakeDoor, agent = new FakeAgent(), infoLines: string[] = []) {
  const runner = new EidoverseBodyRunner({ walkTimeoutMs: 5_000, maxPendingNotes: 4 }, door, { logger: { warn: () => undefined } });
  const adapter = new EidoverseEmbodiedSessionAdapter({
    worldName: "commons",
    agentName: "Artie",
    satelliteClaim: normalizeSatelliteClaimConfig({
      capabilityProfile: "world-avatar",
      satelliteId: "eidoverse-world",
      endpointId: "eidoverse-avatar",
      displayName: "Eidoverse World Avatar",
    }),
    placeMap: parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        commons: { placeId: "eidoverse:commons", regions: { plaza: "eidoverse:commons:plaza" } },
        garden: { placeId: "eidoverse:garden" },
      },
    }),
  }, {
    embodiedSessions: new EmbodiedSessionRegistry("satellite.endpoint"),
    sessions: new SessionStore(60),
    agent,
    look: door,
    say: { say: async () => undefined },
    body: runner,
    travel: door,
    logger: { warn: () => undefined, info: (line) => infoLines.push(line) },
  });
  adapter.connect();
  return { adapter, runner };
}

test("perceive reports the body's own position, people with coordinates, and the mapped place", async () => {
  const door = new FakeDoor();
  const { adapter } = adapterWith(door);
  const perception = await adapter.perceive();
  assert.equal(perception.world, "commons");
  assert.equal(perception.placeId, "eidoverse:commons");
  assert.deepEqual([perception.self?.x, perception.self?.z], [0, 0]);
  assert.deepEqual(perception.people.map((p) => [p.id, p.x, p.z]), [["visitor", 5, 0]]);
  adapter.disconnect();
});

test("move to a participant walks to a standoff beside them and reports arrival with coordinates", async () => {
  const door = new FakeDoor();
  const info: string[] = [];
  const { adapter } = adapterWith(door, new FakeAgent(), info);
  const outcome = await adapter.moveTo({ participant: "@Visitor" });
  assert.equal(outcome.accepted, true);
  if (!outcome.accepted) return;
  assert.equal(outcome.walk?.status, "arrived");
  assert.deepEqual(door.walks, [{ x: 3.5, z: 0 }]);
  assert.deepEqual([outcome.walk?.x, outcome.walk?.z], [3.5, 0]);
  assert.ok(info.some((line) => /walk_to arrived at \(3\.5, 0\) in world "commons"/u.test(line)), info.join("\n"));

  const unknown = await adapter.moveTo({ participant: "ghost" });
  assert.deepEqual(unknown, { accepted: false, world: "commons", reason: "participant_unknown" });
  adapter.disconnect();
});

test("move to a mapped region walks there and the next in-world turn keeps that region's place", async () => {
  const door = new FakeDoor();
  const agent = new FakeAgent();
  const { adapter } = adapterWith(door, agent);
  const outcome = await adapter.moveTo({ world: "commons", region: "plaza", position: { x: 8, z: -2 } });
  assert.equal(outcome.accepted && outcome.placeId, "eidoverse:commons:plaza");
  assert.deepEqual(door.walks, [{ x: 8, z: -2 }]);

  await adapter.handleAddressedUtterance({ utteranceId: "u1", userText: "visitor: where are you now?" });
  assert.equal(agent.calls[0]?.channel?.placeId, "eidoverse:commons:plaza", "the walked-to region survives a region-less wake");
  const notes = agent.calls[0]?.channel?.contextNotes ?? [];
  const affordance = notes.find((note) => note.key === "eidoverse.affordances");
  assert.ok(affordance, "every turn tells the model it has a body here");
  assert.match(affordance!.text, /You have a body in this 3D world/u);
  assert.match(affordance!.text, /action=move with participant:"<id>"/u);
  assert.match(affordance!.text, /travel there/u);
  adapter.disconnect();
});

test("move to another world travels first, then walks, and clears the old region", async () => {
  const door = new FakeDoor();
  const { adapter } = adapterWith(door);
  await adapter.moveTo({ region: "plaza", position: { x: 1, z: 1 } });
  const outcome = await adapter.moveTo({ world: "garden", position: { x: 2, z: 3 } });
  assert.deepEqual(door.travels, ["garden"]);
  assert.equal(outcome.accepted && outcome.world, "garden");
  assert.equal(outcome.accepted && outcome.placeId, "eidoverse:garden");
  assert.deepEqual(door.walks.at(-1), { x: 2, z: 3 });
  const perception = await adapter.perceive();
  assert.equal(perception.region, undefined);
  adapter.disconnect();
});

test("a walk longer than the bounded wait answers walking and its outcome reaches a later turn as a note", async () => {
  const door = new FakeDoor();
  door.walkDelayMs = 60;
  const agent = new FakeAgent();
  const { adapter, runner } = adapterWith(door, agent);
  const outcome = await adapter.moveTo({ position: { x: 4, z: 4 }, waitMs: 5 });
  assert.equal(outcome.accepted && outcome.walk?.status, "walking");
  await runner.close();
  await adapter.handleAddressedUtterance({ utteranceId: "u2", userText: "visitor: there yet?" });
  assert.ok((agent.calls[0]?.channel?.contextNotes ?? []).some((note) => note.key === "eidoverse.body"));
  adapter.disconnect();
});

test("act runs allowlisted body and creation verbs and refuses the rest", async () => {
  const door = new FakeDoor();
  const { adapter } = adapterWith(door);
  assert.deepEqual(await adapter.act("emote", { name: "wave" }), { accepted: true, verb: "emote", outcome: "expressed", reply: "you wave" });
  assert.equal((await adapter.act("spawn", { query: "bench" })).accepted, true);
  assert.equal((await adapter.act("remove", { id: "ab12" })).accepted, true);
  assert.equal((await adapter.act("face", { target: "visitor" })).accepted, true);
  assert.equal((await adapter.act("posture", { kind: "sit" })).accepted, true);
  assert.deepEqual(await adapter.act("world_verb", { verb: "terrain" }), { accepted: false, verb: "world_verb", reason: "not_allowlisted" });
  assert.deepEqual(await adapter.act("emote", { name: "moonwalk" }), { accepted: false, verb: "emote", reason: "not_allowlisted" });
  assert.deepEqual(door.verbs, ["emote wave", "spawn bench", "remove ab12", "face visitor", "posture sit"]);
  adapter.disconnect();
});

test("body action parsing covers the new verbs and classifies world-editing ones", () => {
  assert.deepEqual(parseEidoverseBodyAction("face", { x: 1, z: 2 }), { name: "face", x: 1, z: 2 });
  assert.deepEqual(parseEidoverseBodyAction("set_avatar", { avatar: "kitsune" }), { name: "set_avatar", avatar: "kitsune" });
  assert.throws(() => parseEidoverseBodyAction("spawn", {}), /requires lib or query/u);
  assert.throws(() => parseEidoverseBodyAction("remove", { id: "" }), /invalid/u);
  assert.throws(() => parseEidoverseBodyAction("remove", {}), /requires an entity id/u);
  assert.throws(() => parseEidoverseBodyAction("place", { id: "x" }), /not allowlisted/u);
  assert.equal(isEidoverseWorldEditAction("spawn"), true);
  assert.equal(isEidoverseWorldEditAction("walk_to"), false);
});
