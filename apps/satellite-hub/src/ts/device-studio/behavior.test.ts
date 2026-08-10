import assert from "node:assert/strict";
import test from "node:test";

import {
  behaviorFixtures,
  danceSingAlongBehavior,
  fixtureMotionDisplayProfile,
  fixtureScreenOnlyProfile,
  neutralBehavior,
} from "./fixtures.js";
import {
  createBehaviorLibrary,
  createBehaviorPlayback,
  createFixtureBehaviorLibrary,
  exportBehaviorLibrary,
  exportBehaviorTimeline,
  importBehaviorLibraryJson,
  importBehaviorTimeline,
  isGeneratedBehavior,
  isHardwareVerifiedBehavior,
  normalizeBehaviorTimeline,
  sampleBehaviorRenderState,
} from "./behavior.js";
import type {
  BehaviorEvent,
  BehaviorFrameApplyEvent,
  BehaviorLibraryEntry,
  BehaviorPlaybackStartEvent,
  BehaviorPlaybackStopEvent,
} from "./behavior.js";
import type { BehaviorTimeline } from "./model.js";

test("fixture behaviors load into a listable library with source and verification metadata", () => {
  const library = createFixtureBehaviorLibrary();

  assert.equal(library.size, behaviorFixtures.length);
  assert.deepEqual(
    library.list().map((entry) => entry.id),
    behaviorFixtures.map((behavior) => behavior.id).sort(),
  );

  const neutral = library.require(neutralBehavior.id);
  assert.equal(neutral.id, neutralBehavior.id);
  assert.equal(isGeneratedBehavior(neutral), true);
  assert.equal(isHardwareVerifiedBehavior(neutral), false);

  const neutralEntry = requireEntry(library.list(), neutralBehavior.id);
  assert.equal(neutralEntry.sourceLabel, "Host-generated Device Studio fixture");
  assert.equal(neutralEntry.provenanceSource, "test-fixture");
  assert.equal(neutralEntry.generated, true);
  assert.equal(neutralEntry.hardwareVerificationStatus, "simulated-only");
});

test("behavior normalization orders frames and calculates duration deterministically", () => {
  const { durationMs: _durationMs, frames, ...withoutDuration } = danceSingAlongBehavior;
  const unordered: BehaviorTimeline = {
    ...withoutDuration,
    id: "behavior.unordered-dance",
    frames: [...frames].reverse(),
  };

  const normalized = normalizeBehaviorTimeline(unordered);

  assert.deepEqual(normalized.frames.map((frame) => frame.atMs), [0, 250, 500, 800, 1000]);
  assert.equal(normalized.durationMs, 1200);
  assert.deepEqual(normalized.channels, ["expression", "viseme", "joints", "display", "backlight", "leds"]);
});

test("library filters by profile, channel, provenance, and hardware verification", () => {
  const officialVerified: BehaviorTimeline = {
    ...neutralBehavior,
    id: "behavior.official-verified",
    name: "Official Verified",
    provenance: {
      label: "Official vendor reference",
      source: "official",
    },
    hardwareVerification: {
      status: "verified-on-hardware",
      label: "Verified on a bench device",
      verifiedAt: "2026-05-11T00:00:00Z",
      verifiedBy: "device-lab",
    },
  };
  const library = createBehaviorLibrary([danceSingAlongBehavior, neutralBehavior, officialVerified]);

  assert.deepEqual(
    library.list({ profile: fixtureScreenOnlyProfile, channel: "joints" }).map((entry) => entry.id),
    [],
  );
  assert.deepEqual(
    library.list({ profile: fixtureMotionDisplayProfile, channel: "joints" }).map((entry) => entry.id),
    [danceSingAlongBehavior.id],
  );
  assert.deepEqual(
    library.list({ generated: false }).map((entry) => entry.id),
    [officialVerified.id],
  );
  assert.deepEqual(
    library.list({ provenanceSource: "official", hardwareVerified: true }).map((entry) => entry.id),
    [officialVerified.id],
  );
  assert.deepEqual(
    library.list({ hardwareVerificationStatus: "simulated-only" }).map((entry) => entry.id),
    [danceSingAlongBehavior.id, neutralBehavior.id],
  );
});

test("import and export helpers produce canonical JSON and structured events", () => {
  const events: BehaviorEvent[] = [];
  const emit = (event: BehaviorEvent): void => {
    events.push(event);
  };
  let clock = 10;
  const now = (): number => clock++;

  const exported = exportBehaviorTimeline(danceSingAlongBehavior, { emit, now, space: 0 });
  const imported = importBehaviorTimeline(exported, { emit, now });
  const exportedAgain = exportBehaviorTimeline(imported, { space: 0 });

  assert.equal(exportedAgain, exported);
  assert.equal(imported.id, danceSingAlongBehavior.id);
  assert.deepEqual(imported.frames.map((frame) => frame.atMs), [0, 250, 500, 800, 1000]);

  const libraryJson = exportBehaviorLibrary(createBehaviorLibrary([neutralBehavior, danceSingAlongBehavior]), {
    emit,
    now,
    space: 0,
  });
  const importedLibrary = importBehaviorLibraryJson(libraryJson, { emit, now });

  assert.equal(exportBehaviorLibrary(importedLibrary, { space: 0 }), libraryJson);
  assert.deepEqual(
    importedLibrary.list().map((entry) => entry.id),
    [danceSingAlongBehavior.id, neutralBehavior.id],
  );
  assert.deepEqual(events.map((event) => event.type), [
    "behavior.export",
    "behavior.import",
    "behavior.export",
    "behavior.import",
  ]);
  assert.equal(events[0]?.emittedAtMs, 10);
  assert.equal(events[1]?.emittedAtMs, 11);
  assert.equal(events[0]?.type, "behavior.export");
  assert.equal(events[0]?.behaviorIds.includes(danceSingAlongBehavior.id), true);
});

test("sampling step-holds semantic channels and interpolates joint movement", () => {
  const halfway = sampleBehaviorRenderState(danceSingAlongBehavior, 125, {
    profile: fixtureMotionDisplayProfile,
  });

  assert.equal(halfway.activeFrame?.index, 0);
  assert.equal(halfway.nextFrame?.atMs, 250);
  assert.equal(halfway.expression?.id, "happy");
  assert.equal(halfway.display?.backgroundColor, "#172033");
  assert.equal(halfway.leds["status.rgb"]?.effect, "pulse");
  assert.equal(halfway.joints["head.yaw"]?.value, 1);
  assert.equal(halfway.joints["head.pitch"]?.value, -1);

  const betweenSingFrames = sampleBehaviorRenderState(danceSingAlongBehavior, 375, {
    profile: fixtureMotionDisplayProfile,
  });

  assert.equal(betweenSingFrames.activeFrame?.atMs, 250);
  assert.equal(betweenSingFrames.expression?.id, "singing");
  assert.equal(betweenSingFrames.viseme?.id, "oh");
  assert.equal(betweenSingFrames.leds["status.rgb"]?.effect, "pulse");
  assert.equal(betweenSingFrames.joints["head.yaw"]?.value, -1);
  assert.equal(betweenSingFrames.joints["head.pitch"]?.value, 1);

  const afterLastJointKeyframe = sampleBehaviorRenderState(danceSingAlongBehavior, 1100, {
    profile: fixtureMotionDisplayProfile,
  });

  assert.equal(afterLastJointKeyframe.activeFrame?.label, "finish");
  assert.equal(afterLastJointKeyframe.joints["head.yaw"]?.value, 0);
  assert.equal(afterLastJointKeyframe.joints["head.pitch"]?.value, 0);
  assert.equal(afterLastJointKeyframe.complete, false);
});

test("expression-only one-frame behaviors still sample to a render state", () => {
  const expressionOnly: BehaviorTimeline = {
    id: "behavior.expression-only",
    name: "Expression Only",
    compatibleProfileIds: [],
    channels: ["expression"],
    frames: [
      {
        atMs: 0,
        label: "wink",
        expression: {
          id: "wink",
          intensity: 0.6,
          eyes: "wink",
          mouth: "smile",
        },
      },
    ],
    provenance: {
      label: "Host-generated one-frame behavior",
      source: "host-generated",
    },
    hardwareVerification: {
      status: "simulated-only",
      label: "Simulation only",
    },
  };

  const state = sampleBehaviorRenderState(expressionOnly, 500);

  assert.equal(state.durationMs, 0);
  assert.equal(state.elapsedMs, 0);
  assert.equal(state.progress, 1);
  assert.equal(state.activeFrame?.index, 0);
  assert.equal(state.expression?.id, "wink");
  assert.deepEqual(state.joints, {});
  assert.deepEqual(state.leds, {});
});

test("playback emits structured start, frame apply, and stop events", () => {
  const events: BehaviorEvent[] = [];
  const playback = createBehaviorPlayback({
    timeline: danceSingAlongBehavior,
    profile: fixtureMotionDisplayProfile,
    emit: (event) => events.push(event),
    now: fixedNow(1000),
  });

  const startState = playback.start();
  playback.sample(0);
  playback.sample(100);
  playback.sample(250);
  const stopState = playback.stop("test-complete");

  assert.equal(startState.elapsedMs, 0);
  assert.equal(stopState.elapsedMs, 250);
  assert.deepEqual(events.map((event) => event.type), [
    "behavior.playback.start",
    "behavior.frame.apply",
    "behavior.frame.apply",
    "behavior.playback.stop",
  ]);

  const start = assertStartEvent(events[0]);
  const firstFrame = assertFrameApplyEvent(events[1]);
  const secondFrame = assertFrameApplyEvent(events[2]);
  const stop = assertStopEvent(events[3]);

  assert.equal(start.durationMs, 1200);
  assert.equal(start.renderState.behaviorId, danceSingAlongBehavior.id);
  assert.equal(firstFrame.frame.index, 0);
  assert.equal(firstFrame.frame.atMs, 0);
  assert.equal(secondFrame.frame.index, 1);
  assert.equal(secondFrame.frame.atMs, 250);
  assert.equal(stop.reason, "test-complete");
  assert.equal(stop.elapsedMs, 250);
  assert.equal(events[0]?.emittedAtMs, 1000);
  assert.equal(events[3]?.emittedAtMs, 1003);
});

function requireEntry(entries: BehaviorLibraryEntry[], id: string): BehaviorLibraryEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  assert(entry, `Expected behavior entry ${id}`);
  return entry;
}

function fixedNow(start: number): () => number {
  let current = start;
  return () => current++;
}

function assertStartEvent(event: BehaviorEvent | undefined): BehaviorPlaybackStartEvent {
  assert(event);
  if (event.type !== "behavior.playback.start") {
    throw new Error(`Expected behavior.playback.start, received ${event.type}`);
  }
  return event;
}

function assertStopEvent(event: BehaviorEvent | undefined): BehaviorPlaybackStopEvent {
  assert(event);
  if (event.type !== "behavior.playback.stop") {
    throw new Error(`Expected behavior.playback.stop, received ${event.type}`);
  }
  return event;
}

function assertFrameApplyEvent(event: BehaviorEvent | undefined): BehaviorFrameApplyEvent {
  assert(event);
  if (event.type !== "behavior.frame.apply") {
    throw new Error(`Expected behavior.frame.apply, received ${event.type}`);
  }
  return event;
}
