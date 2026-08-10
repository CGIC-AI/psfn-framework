import assert from "node:assert/strict";
import test from "node:test";

import { sampleBehaviorRenderState } from "../device-studio/behavior.js";
import type {
  BehaviorTimeline,
  HardwareVerification,
  Provenance,
} from "../device-studio/model.js";
import {
  stackChanProfile,
  waveshareEsp32S3RoundTouchProfile,
} from "../device-studio/profiles.js";
import {
  createStackChanPreviewModel,
  formatPreviewMotion,
} from "./stackchan-preview.js";

const TEST_PROVENANCE: Provenance = {
  label: "Stack-chan preview test behavior",
  source: "test-fixture",
};

const SIMULATED_ONLY: HardwareVerification = {
  status: "simulated-only",
  label: "Simulated preview behavior",
};

const previewMotionBehavior: BehaviorTimeline = {
  id: "behavior.preview-test.motion",
  name: "Preview Motion Test",
  compatibleProfileIds: [],
  channels: ["expression", "viseme", "joints", "display", "backlight", "leds"],
  durationMs: 800,
  frames: [
    {
      atMs: 0,
      label: "left",
      expression: {
        id: "curious",
        intensity: 0.8,
        eyes: "wide",
        mouth: "open",
      },
      viseme: {
        id: "oh",
        weight: 0.6,
      },
      joints: {
        "head.yaw": { value: -20 },
        "head.pitch": { value: 8 },
      },
      display: {
        mode: "face",
        backgroundColor: "#172033",
      },
      backlight: {
        brightness: 0.8,
      },
      leds: {
        "status.rgb": {
          color: "#52b6ff",
          brightness: 0.7,
          effect: "pulse",
        },
      },
    },
    {
      atMs: 400,
      label: "right",
      expression: {
        id: "curious",
        intensity: 1,
        eyes: "squint",
        mouth: "smile",
      },
      viseme: {
        id: "ee",
        weight: 0.7,
      },
      joints: {
        "head.yaw": { value: 20 },
        "head.pitch": { value: -8 },
      },
    },
    {
      atMs: 800,
      label: "center",
      expression: {
        id: "happy",
        intensity: 0.7,
        eyes: "open",
        mouth: "smile",
      },
      viseme: {
        id: "sil",
        weight: 1,
      },
      joints: {
        "head.yaw": { value: 0 },
        "head.pitch": { value: 0 },
      },
    },
  ],
  provenance: TEST_PROVENANCE,
  hardwareVerification: SIMULATED_ONLY,
};

test("Stack-chan preview model maps normalized yaw and pitch render state", () => {
  const renderState = sampleBehaviorRenderState(previewMotionBehavior, 300, {
    profile: stackChanProfile,
  });

  const model = createStackChanPreviewModel(stackChanProfile, renderState);

  assert.equal(model.yawDegrees, 10);
  assert.equal(model.pitchDegrees, -4);
  assert.equal(model.hasMotion, true);
  assert.equal(model.displayShape, "rectangular");
  assert.equal(model.hardwareTone, "warning");
  assert.equal(model.hardwareLabel, "Unverified");
  assert.equal(formatPreviewMotion(stackChanProfile, renderState), "Yaw 10deg / Pitch -4deg");
  assert(model.warnings.some((warning) => warning.includes("Not verified")));
  assert(model.warnings.some((warning) => warning.includes("simulation only")));
  assert(model.nonBlankRegions >= 8);
  assert.equal(
    model.fingerprint,
    "stackchan.m5stack.cores3.reference|behavior.preview-test.motion|300|10|-4|curious|oh|warning|2",
  );
});

test("preview model makes unsupported motion and hardware-unverified state explicit", () => {
  const renderState = sampleBehaviorRenderState(previewMotionBehavior, 300, {
    profile: waveshareEsp32S3RoundTouchProfile,
  });

  const model = createStackChanPreviewModel(waveshareEsp32S3RoundTouchProfile, renderState);

  assert.equal(model.hasMotion, false);
  assert.equal(model.displayShape, "round");
  assert.equal(model.yawDegrees, 0);
  assert.equal(model.pitchDegrees, 0);
  assert.equal(formatPreviewMotion(waveshareEsp32S3RoundTouchProfile, renderState), "Motion unavailable");
  assert(model.warnings.some((warning) => warning.includes("No yaw/pitch hardware")));
  assert(model.warnings.some((warning) => warning.includes("Motion degraded")));
  assert.equal(model.hardwareTone, "warning");
  assert.equal(
    model.fingerprint,
    "waveshare.esp32-s3-touch-lcd-1.85|behavior.preview-test.motion|300|0|0|curious|oh|warning|4",
  );
});
