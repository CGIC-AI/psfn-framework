import assert from "node:assert/strict";
import test from "node:test";

import {
  angryBehavior,
  applyBehaviorToProfile,
  behaviorFixtures,
  calculateBehaviorDuration,
  danceSingAlongBehavior,
  deviceProfileFixtures,
  fixtureMotionDisplayProfile,
  fixtureScreenOnlyProfile,
  happyLaughingBehavior,
  isBehaviorCompatibleWithProfile,
  isGeneratedProvenance,
  isHardwareVerified,
  neutralBehavior,
  validateBehaviorTimeline,
  validateDeviceProfile,
} from "./index.js";
import type { BehaviorTimeline, DeviceProfile, ValidationIssue } from "./model.js";

test("device profile and behavior fixtures validate", () => {
  assert.deepEqual(deviceProfileFixtures.map((profile) => profile.id), [
    "fixture.motion-display",
    "fixture.screen-only-round",
  ]);
  assert.deepEqual(behaviorFixtures.map((behavior) => behavior.id), [
    neutralBehavior.id,
    happyLaughingBehavior.id,
    angryBehavior.id,
    danceSingAlongBehavior.id,
  ]);

  for (const profile of deviceProfileFixtures) {
    assert.deepEqual(validateDeviceProfile(profile), [], profile.id);
  }
  for (const behavior of behaviorFixtures) {
    assert.deepEqual(validateBehaviorTimeline(behavior), [], behavior.id);
  }
});

test("validation reports required device profile and timeline fields", () => {
  const invalidProfile: unknown = {
    ...fixtureScreenOnlyProfile,
    id: "",
    name: "",
    display: {
      ...fixtureScreenOnlyProfile.display,
      width: 0,
    },
    touch: {},
    capabilities: {
      input: [],
      output: [],
      control: "interrupt",
    },
    provenance: {
      ...fixtureScreenOnlyProfile.provenance,
      label: "",
    },
    hardwareVerification: {
      status: "",
      label: "",
    },
  };
  const profilePaths = issuePaths(validateDeviceProfile(invalidProfile));

  assert(profilePaths.includes("id"));
  assert(profilePaths.includes("name"));
  assert(profilePaths.includes("display.width"));
  assert(profilePaths.includes("touch.supported"));
  assert(profilePaths.includes("capabilities.input"));
  assert(profilePaths.includes("capabilities.output"));
  assert(profilePaths.includes("capabilities.control"));
  assert(profilePaths.includes("provenance.label"));
  assert(profilePaths.includes("hardwareVerification.status"));
  assert(profilePaths.includes("hardwareVerification.label"));

  const invalidTimeline: unknown = {
    ...neutralBehavior,
    id: "",
    compatibleProfileIds: "fixture.motion-display",
    channels: [],
    frames: [],
    provenance: {
      ...neutralBehavior.provenance,
      label: "",
    },
    hardwareVerification: {
      status: "",
      label: "",
    },
  };
  const timelinePaths = issuePaths(validateBehaviorTimeline(invalidTimeline));

  assert(timelinePaths.includes("id"));
  assert(timelinePaths.includes("compatibleProfileIds"));
  assert(timelinePaths.includes("channels"));
  assert(timelinePaths.includes("frames"));
  assert(timelinePaths.includes("provenance.label"));
  assert(timelinePaths.includes("hardwareVerification.status"));
  assert(timelinePaths.includes("hardwareVerification.label"));
});

test("applying a behavior to a screen-only profile degrades unsupported channels", () => {
  const result = applyBehaviorToProfile(fixtureScreenOnlyProfile, danceSingAlongBehavior);

  assert.equal(result.profileId, fixtureScreenOnlyProfile.id);
  assert.equal(result.behaviorId, danceSingAlongBehavior.id);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.supportedChannels, ["expression", "viseme", "display", "backlight"]);
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "joints"));
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "leds"));
  assert.deepEqual(result.timeline.channels, ["expression", "viseme", "display", "backlight"]);

  for (const frame of result.timeline.frames) {
    assert.equal(frame.joints, undefined);
    assert.equal(frame.leds, undefined);
  }
  assert(result.timeline.frames.some((frame) => frame.expression?.id === "singing"));
  assert(result.timeline.frames.some((frame) => frame.display?.mode === "face"));
});

test("timeline validation covers ordering and duration calculation", () => {
  assert.equal(calculateBehaviorDuration(danceSingAlongBehavior), 1200);

  const { durationMs: _durationMs, ...withoutDuration } = danceSingAlongBehavior;
  assert.equal(calculateBehaviorDuration(withoutDuration), 1200);

  const unordered: BehaviorTimeline = {
    ...neutralBehavior,
    id: "behavior.unordered",
    durationMs: 1000,
    frames: [
      {
        atMs: 500,
        expression: { id: "happy" },
      },
      {
        atMs: 200,
        expression: { id: "neutral" },
      },
    ],
  };
  const unorderedPaths = issuePaths(validateBehaviorTimeline(unordered));
  assert(unorderedPaths.includes("frames[1].atMs"));

  const tooShort: BehaviorTimeline = {
    ...danceSingAlongBehavior,
    id: "behavior.too-short",
    durationMs: 1000,
  };
  const tooShortPaths = issuePaths(validateBehaviorTimeline(tooShort));
  assert(tooShortPaths.includes("durationMs"));
});

test("provenance and hardware verification state are explicit", () => {
  assert.equal(neutralBehavior.provenance.label, "Host-generated Device Studio fixture");
  assert.equal(isGeneratedProvenance(neutralBehavior.provenance), true);
  assert.equal(isGeneratedProvenance({
    label: "Official vendor sample",
    source: "official",
  }), false);

  assert.equal(fixtureMotionDisplayProfile.hardwareVerification.status, "unverified");
  assert.equal(isHardwareVerified(fixtureMotionDisplayProfile.hardwareVerification), false);

  const verifiedProfile: DeviceProfile = {
    ...fixtureMotionDisplayProfile,
    hardwareVerification: {
      status: "verified-on-hardware",
      label: "Measured on a bench device",
      verifiedAt: "2026-05-11T00:00:00Z",
      verifiedBy: "device-lab",
    },
  };
  assert.equal(isHardwareVerified(verifiedProfile.hardwareVerification), true);

  const motionOnlyBehavior: BehaviorTimeline = {
    ...neutralBehavior,
    compatibleProfileIds: [fixtureMotionDisplayProfile.id],
  };
  assert.equal(isBehaviorCompatibleWithProfile(fixtureMotionDisplayProfile, motionOnlyBehavior), true);
  assert.equal(isBehaviorCompatibleWithProfile(fixtureScreenOnlyProfile, motionOnlyBehavior), false);
  assert.equal(applyBehaviorToProfile(fixtureScreenOnlyProfile, motionOnlyBehavior).compatible, false);
});

function issuePaths(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.path);
}
