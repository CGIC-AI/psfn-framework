import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { HubControlConfig } from "../shared/env.js";
import type { WorldAvatarMoveRequest } from "../shared/protocol.js";
import { createHubDeviceRegistryAuthority, type HubDeviceRegistry } from "./device-registry.js";
import { HubControlServer, type HubWorldControlPort } from "./home-assistant/control-server.js";

const CONTROL_TOKEN = "hub-control-world-test-token";
const DEVICE_TOKEN = "avatar-device-test-token";
const REGISTRY: HubDeviceRegistry = {
  schemaVersion: 1,
  devices: [{
    deviceId: "avatar-device",
    deviceName: "Avatar Device",
    satelliteId: "eidoverse-world",
    satelliteName: "Eidoverse World Avatar",
    endpointId: "eidoverse-avatar",
    claimType: "world-avatar",
    credentialSha256: createHash("sha256").update(DEVICE_TOKEN).digest("hex"),
    enrollmentVersion: 1,
    enrollmentAssurance: "device_credential",
    enrollmentStatus: "active",
    companionId: "11111111-1111-4111-8111-111111111111",
    placeId: "eidoverse:commons",
    homeAssistantEntityIds: [],
    maxCapabilities: { input: ["text"], output: ["text"], control: ["world_body", "world_travel"], safety: ["local_only"] },
  }],
};
const CONFIG: HubControlConfig = { bindHost: "127.0.0.1", port: 0, token: CONTROL_TOKEN, maxBodyBytes: 4096 };

class RecordingWorld implements HubWorldControlPort {
  readonly moves: WorldAvatarMoveRequest[] = [];
  readonly acts: Array<{ verb: string; args: Record<string, unknown> }> = [];
  perceiveCalls = 0;

  async perceive() {
    this.perceiveCalls += 1;
    return {
      world: "commons",
      placeId: "eidoverse:commons",
      capturedAt: "2026-09-09T18:00:00.000Z",
      self: { id: "nova", world: "commons", positionKnown: true, x: 0, z: 0, facing: "S" },
      people: [{ id: "visitor", positionKnown: true, x: 2, z: 2.5, distanceM: 3.2, bearing: "NE", doing: "standing" }],
      things: [],
      recent: [],
      raw: "",
    };
  }

  mapCalls = 0;
  snapshotViews: string[] = [];

  async snapshot(view: "first" | "third" | "selfie") {
    this.snapshotViews.push(view);
    return view === "selfie"
      ? { available: false as const, world: "commons", view, reason: "unavailable" as const }
      : { available: true as const, world: "commons", view, mimeType: "image/png", dataBase64: "iVBORw0KGgo=", bytes: 8, capturedAt: "2026-09-10T18:00:00.000Z" };
  }

  async map() {
    this.mapCalls += 1;
    return {
      world: "commons",
      placeId: "eidoverse:commons",
      places: [{ placeId: "eidoverse:commons" }, { placeId: "eidoverse:commons:plaza", region: "plaza" }],
      room: { label: "kitchen", labelled: true, widthM: 4, depthM: 3, areaM2: 12, insideEntityId: "ent-7", waysOut: ["a door on its north to the hall"], sealed: false },
      terrain: { sizeM: 400 },
      tools: [{ name: "look", description: "Look around." }, { name: "walk_to" }],
      capturedAt: "2026-09-10T18:00:00.000Z",
    };
  }

  async move(input: WorldAvatarMoveRequest) {
    this.moves.push(input);
    return { accepted: true as const, world: "commons", placeId: "eidoverse:commons", walk: { status: "arrived" as const, x: 1.1, z: 1.4 } };
  }

  async act(verb: string, args: Record<string, unknown>) {
    this.acts.push({ verb, args });
    return { accepted: true as const, verb, outcome: "expressed", reply: "waving" };
  }
}

async function withServer(
  world: HubWorldControlPort | null,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const control = new HubControlServer(CONFIG, null, createHubDeviceRegistryAuthority(() => REGISTRY), world);
  await control.start();
  try {
    const address = control.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await control.close();
  }
}

async function post(baseUrl: string, path: string, body: unknown, token = CONTROL_TOKEN): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("world routes execute the companion's own perceive, move and act with the control token and no device", async () => {
  const world = new RecordingWorld();
  await withServer(world, async (baseUrl) => {
    const perceive = await post(baseUrl, "/internal/v1/world/perceive", {});
    assert.equal(perceive.status, 200);
    const perception = await perceive.json() as { people: Array<{ id: string; x: number; z: number }> };
    assert.deepEqual(perception.people.map((p) => [p.id, p.x, p.z]), [["visitor", 2, 2.5]]);

    const move = await post(baseUrl, "/internal/v1/world/move", { participant: "@visitor", region: "plaza", waitMs: 99_000 });
    assert.equal(move.status, 200);
    assert.deepEqual(await move.json(), {
      accepted: true, world: "commons", placeId: "eidoverse:commons", walk: { status: "arrived", x: 1.1, z: 1.4 },
    });
    assert.deepEqual(world.moves, [{ participant: "@visitor", region: "plaza", waitMs: 30_000 }]);

    const act = await post(baseUrl, "/internal/v1/world/act", { verb: "emote", arguments: { name: "wave" } });
    assert.equal(act.status, 200);
    assert.deepEqual(world.acts, [{ verb: "emote", args: { name: "wave" } }]);

    // gs899/g8xyn: the world's map rides the same control-token-only door.
    const map = await post(baseUrl, "/internal/v1/world/map", {});
    assert.equal(map.status, 200);
    const mapBody = (await map.json()) as { world: string; places: unknown[]; tools: Array<{ name: string }>; room?: { label: string } };
    assert.equal(mapBody.world, "commons");
    assert.equal(mapBody.places.length, 2);
    assert.deepEqual(mapBody.tools.map((tool) => tool.name), ["look", "walk_to"]);
    assert.equal(mapBody.room?.label, "kitchen");
    assert.equal(world.mapCalls, 1);
    const mapWithDevice = await post(baseUrl, "/internal/v1/world/map", {}, DEVICE_TOKEN);
    assert.equal(mapWithDevice.status, 401);
    assert.equal(world.mapCalls, 1);

    // mlhfw: the snapshot route validates the view and relays availability honestly.
    const snap = await post(baseUrl, "/internal/v1/world/snapshot", { view: "third" });
    assert.equal(snap.status, 200);
    assert.equal(((await snap.json()) as { available: boolean; view: string }).view, "third");
    const noView = await post(baseUrl, "/internal/v1/world/snapshot", {});
    assert.equal(((await noView.json()) as { view: string }).view, "first");
    const selfie = await post(baseUrl, "/internal/v1/world/snapshot", { view: "selfie" });
    assert.equal(((await selfie.json()) as { available: boolean }).available, false);
    const badView = await post(baseUrl, "/internal/v1/world/snapshot", { view: "drone" });
    assert.equal(badView.status, 400);
    assert.deepEqual(world.snapshotViews, ["third", "first", "selfie"]);
  });
});

test("world routes refuse an enrolled device credential and a bad token alike; the device path stays on the socket", async () => {
  const world = new RecordingWorld();
  await withServer(world, async (baseUrl) => {
    const device = await post(baseUrl, "/internal/v1/world/move", { position: { x: 1, z: 1 } }, DEVICE_TOKEN);
    assert.equal(device.status, 401);
    const bad = await post(baseUrl, "/internal/v1/world/perceive", {}, "not-the-token");
    assert.equal(bad.status, 401);
    assert.equal(world.moves.length, 0);
    assert.equal(world.perceiveCalls, 0);
  });
});

test("world routes validate input and answer world_not_configured without an emanation", async () => {
  await withServer(new RecordingWorld(), async (baseUrl) => {
    const badWorld = await post(baseUrl, "/internal/v1/world/move", { world: "Not A World!" });
    assert.equal(badWorld.status, 400);
    const badPosition = await post(baseUrl, "/internal/v1/world/move", { position: { x: "1", z: 2 } });
    assert.equal(badPosition.status, 400);
    const badVerb = await post(baseUrl, "/internal/v1/world/act", { arguments: {} });
    assert.equal(badVerb.status, 400);
    const get = await fetch(`${baseUrl}/internal/v1/world/perceive`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } });
    assert.equal(get.status, 405);
  });
  await withServer(null, async (baseUrl) => {
    const response = await post(baseUrl, "/internal/v1/world/perceive", {});
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: { type: string } }).error.type, "world_not_configured");
    const ha = await post(baseUrl, "/internal/v1/home-assistant/states", { entityIds: [] });
    assert.equal(ha.status, 409, "Home Assistant routes answer not-configured rather than crashing without a client");
  });
});

test("the control server runs with neither Home Assistant nor a device registry", async () => {
  const control = new HubControlServer(CONFIG, null, null, new RecordingWorld());
  await control.start();
  try {
    const address = control.address() as AddressInfo;
    const response = await post(`http://127.0.0.1:${address.port}`, "/internal/v1/world/perceive", {});
    assert.equal(response.status, 200);
  } finally {
    await control.close();
  }
});
