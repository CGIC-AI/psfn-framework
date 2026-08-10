import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBehaviorToProfile,
  getSupportedBehaviorChannels,
  validateBehaviorTimeline,
  validateDeviceProfile,
} from "./model.js";
import type { BehaviorTimeline, Provenance } from "./model.js";
import {
  concreteDeviceProfileFixtures,
  getConcreteDeviceProfile,
  stackChanProfile,
  waveshareEsp32S3RoundTouchProfile,
} from "./profiles.js";

const TEST_PROVENANCE: Provenance = {
  label: "Profile degradation test behavior",
  source: "test-fixture",
};

const expressiveMotionBehavior: BehaviorTimeline = {
  id: "behavior.profile-degradation",
  name: "Profile Degradation",
  compatibleProfileIds: [],
  channels: ["expression", "viseme", "joints", "display", "backlight", "leds"],
  durationMs: 600,
  frames: [
    {
      atMs: 0,
      label: "supported and extra channels",
      expression: {
        id: "happy",
        intensity: 0.9,
        eyes: "open",
        mouth: "smile",
      },
      viseme: {
        id: "a",
        weight: 0.7,
      },
      joints: {
        "head.yaw": { value: -18 },
        "head.pitch": { value: 7 },
        "body.bob": { value: 3 },
      },
      display: {
        mode: "face",
        backgroundColor: "#101820",
      },
      backlight: {
        brightness: 0.8,
      },
      leds: {
        "status.rgb": {
          color: "#44ff88",
          brightness: 0.85,
          effect: "pulse",
        },
        "badge.rgb": {
          color: "#ffcc33",
          brightness: 0.5,
          effect: "solid",
        },
      },
    },
    {
      atMs: 400,
      durationMs: 200,
      label: "return to neutral",
      expression: {
        id: "neutral",
        intensity: 1,
      },
      viseme: {
        id: "rest",
        weight: 1,
      },
      joints: {
        "head.yaw": { value: 0 },
        "head.pitch": { value: 0 },
      },
      leds: {
        "status.rgb": {
          color: "#223344",
          brightness: 0.35,
          effect: "solid",
        },
      },
    },
  ],
  provenance: TEST_PROVENANCE,
  hardwareVerification: {
    status: "simulated-only",
    label: "Behavior fixture only",
  },
};

test("concrete profile fixtures load and validate", () => {
  assert.deepEqual(concreteDeviceProfileFixtures.map((profile) => profile.id), [
    "stackchan.m5stack.cores3.reference",
    "waveshare.esp32-s3-touch-lcd-1.85",
  ]);
  assert.equal(getConcreteDeviceProfile(stackChanProfile.id), stackChanProfile);
  assert.equal(getConcreteDeviceProfile(waveshareEsp32S3RoundTouchProfile.id), waveshareEsp32S3RoundTouchProfile);
  assert.equal(getConcreteDeviceProfile("missing.profile"), undefined);

  for (const profile of concreteDeviceProfileFixtures) {
    assert.deepEqual(validateDeviceProfile(profile), [], profile.id);
    assert.equal(profile.hardwareVerification.status, "unverified");
    assert(profile.provenance.notes?.length);
    assert(profile.sourceNotes.length > 0);
  }
});

test("Stack-chan profile exposes face, audio, RGB LED, and two movement channels", () => {
  assert.equal(stackChanProfile.display.width, 320);
  assert.equal(stackChanProfile.display.height, 240);
  assert.equal(stackChanProfile.touch.supported, true);
  assert.equal(stackChanProfile.audio.microphone, true);
  assert.equal(stackChanProfile.audio.speaker, true);
  assert(stackChanProfile.capabilities.input.includes("audio"));
  assert(stackChanProfile.capabilities.output.includes("motion"));
  assert(stackChanProfile.capabilities.output.includes("led"));
  assert.deepEqual(stackChanProfile.joints.map((joint) => joint.id), ["head.yaw", "head.pitch"]);
  assert.deepEqual(stackChanProfile.leds.map((led) => led.id), ["status.rgb"]);
  assert(stackChanProfile.face.expressions.includes("happy"));
  assert(stackChanProfile.face.visemes.includes("wide"));
  assert.deepEqual(getSupportedBehaviorChannels(stackChanProfile), [
    "expression",
    "viseme",
    "joints",
    "display",
    "backlight",
    "leds",
  ]);

  for (const joint of stackChanProfile.joints) {
    assert.equal(joint.hardwareVerification?.status, "unverified");
    assert.match(joint.hardwareVerification?.notes ?? "", /Host-side|host-side|simulator/);
  }
});

test("Waveshare round LCD profile is touch-capable and screen-centric", () => {
  assert.equal(waveshareEsp32S3RoundTouchProfile.display.width, 360);
  assert.equal(waveshareEsp32S3RoundTouchProfile.display.height, 360);
  assert.equal(waveshareEsp32S3RoundTouchProfile.display.shape, "round");
  assert.equal(waveshareEsp32S3RoundTouchProfile.touch.supported, true);
  assert.equal(waveshareEsp32S3RoundTouchProfile.audio.microphone, false);
  assert.equal(waveshareEsp32S3RoundTouchProfile.audio.speaker, false);
  assert.deepEqual(waveshareEsp32S3RoundTouchProfile.capabilities.input, ["text", "touch"]);
  assert.deepEqual(waveshareEsp32S3RoundTouchProfile.capabilities.output, [
    "display",
    "expression",
    "viseme",
    "backlight",
  ]);
  assert.deepEqual(waveshareEsp32S3RoundTouchProfile.joints, []);
  assert.deepEqual(waveshareEsp32S3RoundTouchProfile.leds, []);
  assert.equal(waveshareEsp32S3RoundTouchProfile.rendererHints.movementPreview, "none");
  assert.deepEqual(getSupportedBehaviorChannels(waveshareEsp32S3RoundTouchProfile), [
    "expression",
    "viseme",
    "display",
    "backlight",
  ]);

  assert(!waveshareEsp32S3RoundTouchProfile.capabilities.output.includes("motion"));
  assert(!waveshareEsp32S3RoundTouchProfile.capabilities.output.includes("led"));
  assert(!waveshareEsp32S3RoundTouchProfile.capabilities.output.includes("audio"));
  assert(!waveshareEsp32S3RoundTouchProfile.capabilities.output.includes("speech"));
});

test("behavior degradation keeps Stack-chan supported channels and drops unknown targets", () => {
  assert.deepEqual(validateBehaviorTimeline(expressiveMotionBehavior), []);

  const result = applyBehaviorToProfile(stackChanProfile, expressiveMotionBehavior);
  const [firstFrame] = result.timeline.frames;

  assert(firstFrame);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.supportedChannels, [
    "expression",
    "viseme",
    "joints",
    "display",
    "backlight",
    "leds",
  ]);
  assert.deepEqual(result.timeline.channels, ["expression", "viseme", "joints", "display", "backlight", "leds"]);
  assert.deepEqual(Object.keys(firstFrame.joints ?? {}).sort(), ["head.pitch", "head.yaw"]);
  assert.deepEqual(Object.keys(firstFrame.leds ?? {}), ["status.rgb"]);
  assert.equal(firstFrame.expression?.id, "happy");
  assert.equal(firstFrame.viseme?.id, "a");
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "joints" && ignored.targetId === "body.bob"));
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "leds" && ignored.targetId === "badge.rgb"));
});

test("behavior degradation removes unsupported motion and LED channels from Waveshare profile", () => {
  const result = applyBehaviorToProfile(waveshareEsp32S3RoundTouchProfile, expressiveMotionBehavior);

  assert.equal(result.compatible, true);
  assert.deepEqual(result.supportedChannels, ["expression", "viseme", "display", "backlight"]);
  assert.deepEqual(result.timeline.channels, ["expression", "viseme", "display", "backlight"]);
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "joints" && ignored.reason.includes("does not support")));
  assert(result.ignoredChannels.some((ignored) => ignored.channel === "leds" && ignored.reason.includes("does not support")));

  for (const frame of result.timeline.frames) {
    assert.equal(frame.joints, undefined);
    assert.equal(frame.leds, undefined);
  }
  assert(result.timeline.frames.some((frame) => frame.expression?.id === "happy"));
  assert(result.timeline.frames.some((frame) => frame.display?.mode === "face"));
});
