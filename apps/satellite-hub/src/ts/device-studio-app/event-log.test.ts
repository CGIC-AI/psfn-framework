import assert from "node:assert/strict";
import test from "node:test";

import type { BehaviorEvent } from "../device-studio/behavior.js";
import type { DeviceStudioTransportLogEntry } from "../device-studio/transport.js";
import {
  DeviceStudioAppEventLog,
  exportDeviceStudioEventLog,
  formatDeviceStudioEventForClipboard,
} from "./event-log.js";

test("app event log appends structured records with context", () => {
  const log = new DeviceStudioAppEventLog({
    clock: () => new Date("2026-05-11T16:30:00.000Z"),
  });

  const first = log.append({
    source: "user",
    kind: "command.submit",
    mode: "mock",
    profileId: "fixture.screen-only-round",
    sessionId: "device-studio:fixture-screen-only-round",
    payload: { text: "hello" },
  });

  assert.equal(first.id, 1);
  assert.equal(first.at, "2026-05-11T16:30:00.000Z");
  assert.equal(first.source, "user");
  assert.equal(first.profileId, "fixture.screen-only-round");
  assert.deepEqual(log.entries, [first]);
});

test("transport logs preserve source, direction, message type, and payload", () => {
  const log = new DeviceStudioAppEventLog();
  const transportEntry: DeviceStudioTransportLogEntry = {
    id: 7,
    at: "2026-05-11T16:31:00.000Z",
    source: "mock",
    direction: "in",
    kind: "hub.message",
    state: "ready",
    profileId: "fixture.motion-display",
    sessionId: "device-studio:fixture-motion-display",
    channelId: "satellite.endpoint:device-studio:fixture-motion-display",
    messageType: "message",
    payload: {
      type: "message",
      data: { role: "assistant", content: "ok", final: true },
    },
  };

  const entry = log.appendTransportLog(transportEntry, { mode: "mock" });

  assert.equal(entry.id, 1);
  assert.equal(entry.source, "mock");
  assert.equal(entry.direction, "in");
  assert.equal(entry.kind, "hub.message");
  assert.equal(entry.mode, "mock");
  assert.equal(entry.messageType, "message");
  assert.deepEqual(entry.payload, transportEntry.payload);
});

test("behavior import/export events are tagged separately from playback events", () => {
  const log = new DeviceStudioAppEventLog();
  const exported: BehaviorEvent = {
    schemaVersion: 1,
    source: "device-studio.behavior",
    emittedAtMs: Date.parse("2026-05-11T16:32:00.000Z"),
    type: "behavior.export",
    count: 1,
    behaviorIds: ["behavior.neutral"],
    bytes: 120,
    behaviors: [{
      id: "behavior.neutral",
      name: "Neutral",
      sourceLabel: "fixture",
      provenanceSource: "test-fixture",
      generated: true,
      hardwareVerificationStatus: "simulated-only",
      hardwareVerified: false,
    }],
  };
  const behavior = exported.behaviors[0];
  assert.ok(behavior);
  const playback: BehaviorEvent = {
    schemaVersion: 1,
    source: "device-studio.behavior",
    emittedAtMs: Date.parse("2026-05-11T16:32:01.000Z"),
    type: "behavior.frame.apply",
    profileId: "fixture.motion-display",
    elapsedMs: 0,
    behavior,
    frame: { index: 0, atMs: 0 },
    renderState: {
      behaviorId: "behavior.neutral",
      behaviorName: "Neutral",
      profileId: "fixture.motion-display",
      requestedElapsedMs: 0,
      elapsedMs: 0,
      durationMs: 1,
      progress: 0,
      complete: false,
      sourceLabel: "fixture",
      provenanceSource: "test-fixture",
      generated: true,
      hardwareVerificationStatus: "simulated-only",
      hardwareVerified: false,
      compatible: true,
      channels: ["expression"],
      supportedChannels: ["expression"],
      ignoredChannels: [],
      activeFrame: { index: 0, atMs: 0 },
      expression: { id: "neutral" },
      joints: {},
      leds: {},
    },
  };

  assert.equal(log.appendBehaviorEvent(exported).source, "import/export");
  assert.equal(log.appendBehaviorEvent(playback).source, "behavior");
  assert.equal(log.entries[0]?.summary, "1 exported / 120 bytes");
  assert.equal(log.entries[1]?.profileId, "fixture.motion-display");
});

test("event log exports and clipboard formatting are JSON envelopes", () => {
  const log = new DeviceStudioAppEventLog({
    clock: () => new Date("2026-05-11T16:33:00.000Z"),
  });
  log.append({ source: "hardware verification", kind: "hardware.profile", payload: { status: "unverified" } });

  const exported = exportDeviceStudioEventLog(log.entries, {
    exportedAt: "2026-05-11T16:34:00.000Z",
    space: 0,
  });
  assert.equal(
    exported,
    '{"schemaVersion":1,"exportedAt":"2026-05-11T16:34:00.000Z","count":1,"entries":[{"id":1,"at":"2026-05-11T16:33:00.000Z","source":"hardware verification","kind":"hardware.profile","payload":{"status":"unverified"}}]}',
  );

  assert.match(formatDeviceStudioEventForClipboard(log.entries), /"schemaVersion": 1/);
});
