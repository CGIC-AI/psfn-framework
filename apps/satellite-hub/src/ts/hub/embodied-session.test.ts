import assert from "node:assert/strict";
import test from "node:test";

import {
  canReceiveEmotion,
  canReceiveStreamingAudio,
  EmbodiedSessionRegistry,
  THIN_SHELL_CAPABILITIES,
  VOXTA_VAM_CAPABILITIES,
} from "./embodied-session.js";

test("embodied session registry derives one stable PSFN hub channel", () => {
  const registry = new EmbodiedSessionRegistry();

  const first = registry.attachSatellite({
    sessionId: "thin-shell:demo",
    satelliteId: "thin-shell",
    satelliteName: "Thin Shell",
    capabilities: THIN_SHELL_CAPABILITIES,
  });
  const second = registry.attachSatellite({
    sessionId: "thin-shell:demo",
    satelliteId: "pi-mic",
    satelliteName: "Pi Mic",
  });

  assert.equal(first.session.channelId, "satellite.endpoint:thin-shell:demo");
  assert.equal(second.session.channelId, first.session.channelId);
  assert.deepEqual(
    registry.getContext("thin-shell:demo", "thin-shell").activeSatellites.map((satellite) => satellite.id),
    ["thin-shell", "pi-mic"],
  );
});

test("thin shell capabilities are text-only for assistant output", () => {
  assert.equal(canReceiveStreamingAudio(THIN_SHELL_CAPABILITIES), false);
  assert.equal(canReceiveEmotion(THIN_SHELL_CAPABILITIES), false);
  assert.equal(canReceiveEmotion(VOXTA_VAM_CAPABILITIES), true);
});

test("situated context binds and unbinds only the current satellite attachment", () => {
  const registry = new EmbodiedSessionRegistry();
  const attachment = registry.attachSatellite({
    sessionId: "realtime:phone",
    satelliteId: "phone",
    satelliteName: "Phone",
  });
  registry.setSituatedContext("realtime:phone", "phone", attachment.ownership, {
    placeId: "home",
    contextNotes: [],
  });
  const atHome = registry.getContext("realtime:phone", "phone", attachment.ownership);
  assert.equal(atHome.placeId, "home");
  assert.deepEqual(atHome.contextNotes, []);

  registry.setSituatedContext("realtime:phone", "phone", attachment.ownership, {
    placeId: null,
    contextNotes: [{ key: "location", text: "Out, near Home." }],
  });
  const context = registry.getContext("realtime:phone", "phone", attachment.ownership);
  assert.equal(context.placeId, null);
  assert.deepEqual(context.contextNotes, [{ key: "location", text: "Out, near Home." }]);
  assert.doesNotMatch(JSON.stringify(context), /lat|lon|coordinate/i);
});

test("detaching an enrolled satellite removes its cached assertion authority", () => {
  const registry = new EmbodiedSessionRegistry();
  const attachment = registry.attachSatellite({
    sessionId: "realtime:office-device",
    satelliteId: "office",
    satelliteName: "Office",
    deviceAuthority: {
      deviceId: "office-device",
      enrollmentVersion: 7,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "office",
    },
  });

  registry.detachSatellite("realtime:office-device", "office", attachment.ownership);

  assert.equal(registry.getSession("realtime:office-device"), null);
});

test("stale attachment cleanup cannot detach a newer authenticated connection", () => {
  const registry = new EmbodiedSessionRegistry();
  const deviceAuthority = {
    deviceId: "office-device",
    enrollmentVersion: 7,
    enrollmentAssurance: "device_credential" as const,
    enrollmentStatus: "active" as const,
    companionId: "11111111-1111-4111-8111-111111111111",
    placeId: "office",
  };
  const stale = registry.attachSatellite({
    sessionId: "realtime:office-device",
    satelliteId: "office",
    satelliteName: "Old Office Connection",
    deviceAuthority,
  });
  const current = registry.attachSatellite({
    sessionId: "realtime:office-device",
    satelliteId: "office",
    satelliteName: "Current Office Connection",
    deviceAuthority,
  });

  assert.equal(
    registry.detachSatellite("realtime:office-device", "office", stale.ownership),
    false,
  );
  assert.equal(
    registry.getContext("realtime:office-device", "office", current.ownership).deviceAuthority?.deviceId,
    "office-device",
  );
  assert.throws(
    () => registry.getContext("realtime:office-device", "office", stale.ownership),
    /attachment is not current/,
  );
  assert.equal(
    registry.detachSatellite("realtime:office-device", "office", current.ownership),
    true,
  );
  assert.equal(registry.getSession("realtime:office-device"), null);
  assert.throws(
    () => registry.getContext("realtime:office-device", "office", current.ownership),
    /attachment is not current/,
  );
  assert.throws(
    () => registry.getContext("realtime:office-device", "office"),
    /Satellite is not attached/,
  );
});
