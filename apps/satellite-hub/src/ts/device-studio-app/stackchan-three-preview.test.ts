import assert from "node:assert/strict";
import test from "node:test";

import { stackChanModelManifest } from "../device-studio/assets.js";
import type { StackChanPreviewModel } from "./stackchan-preview.js";
import {
  createStackChanThreePose,
  createStackChanThreeRigPlan,
} from "./stackchan-three-preview.js";

test("Three.js Stack-chan rig plan uses manifest parts and physical pivot groups", () => {
  const plan = createStackChanThreeRigPlan(stackChanModelManifest);

  assert.equal(plan.renderer, "three");
  assert.equal(plan.profileId, "stackchan.m5stack.cores3.reference");
  assert.equal(plan.coordinateSystem.unit, "millimeters");
  assert.deepEqual(plan.parts.map((part) => `${part.role}:${part.id}`), [
    "body:body.shell",
    "head:head.shell",
    "display:display.face",
    "neck:neck.pan-tilt",
    "leds:status.rgb",
  ]);
  assert.deepEqual(plan.pivots.map((pivot) => `${pivot.jointId}:${pivot.id}`), [
    "head.yaw:pivot.head.yaw",
    "head.pitch:pivot.head.pitch",
  ]);
  assert.deepEqual(plan.cadAssets.map((asset) => `${asset.mount}:${asset.id}`), [
    "pitch:case.shell",
    "rig:feet.top",
    "rig:feet.bottom",
    "yaw:bracket.front",
    "yaw:bracket.back",
    "pitch:tilt.horn",
  ]);

  const yaw = plan.pivots.find((pivot) => pivot.id === "pivot.head.yaw");
  const pitch = plan.pivots.find((pivot) => pivot.id === "pivot.head.pitch");
  const shell = plan.cadAssets.find((asset) => asset.id === "case.shell");
  assert(yaw);
  assert(pitch);
  assert(shell);
  assert.deepEqual(yaw.axis, { x: 0, y: 1, z: 0 });
  assert.deepEqual(pitch.axis, { x: 1, y: 0, z: 0 });
  assert(yaw.childPartIds.includes("head.shell"));
  assert(pitch.childPartIds.includes("display.face"));
  assert.equal(shell.path, "assets/stackchan/source/shell.stl");
  assert.equal(shell.mount, "pitch");
});

test("Three.js Stack-chan pose applies behavior yaw and pitch exactly", () => {
  const pose = createStackChanThreePose(makePreviewModel({
    yawDegrees: 14,
    pitchDegrees: -6,
    leftEyeMode: "wide",
    rightEyeMode: "squint",
    mouthMode: "sing",
    ledColor: "#52B6FF",
  }));

  assert.equal(round(pose.yawRadians), round(14 * Math.PI / 180));
  assert.equal(round(pose.pitchRadians), round(6 * Math.PI / 180));
  assert.equal(pose.headYawDegrees, 14);
  assert.equal(pose.headPitchDegrees, -6);
  assert.equal(pose.leftEyeScaleY, 1.28);
  assert.equal(pose.rightEyeScaleY, 0.45);
  assert.deepEqual({ x: pose.mouthScaleX, y: pose.mouthScaleY }, { x: 0.55, y: 1.05 });
  assert.equal(pose.ledColor, "#52B6FF");
});

function makePreviewModel(overrides: Partial<StackChanPreviewModel>): StackChanPreviewModel {
  return {
    profileId: "stackchan.m5stack.cores3.reference",
    behaviorId: "behavior.dance-sing-along",
    behaviorName: "Dance Sing-along",
    formFactor: "stackchan-style",
    displayShape: "rectangular",
    yawDegrees: 0,
    pitchDegrees: 0,
    hasMotion: true,
    expressionLabel: "happy",
    visemeLabel: "rest",
    leftEyeMode: "open",
    rightEyeMode: "open",
    mouthMode: "smile",
    screenBackground: "#172033",
    ledColor: "#50d6c6",
    ledEffect: "pulse",
    progressPercent: 0,
    elapsedLabel: "0 ms",
    frameLabel: "ready @ 0 ms",
    hardwareTone: "warning",
    hardwareLabel: "Unverified",
    warnings: [],
    joints: [],
    nonBlankRegions: 8,
    fingerprint: "test",
    ...overrides,
  };
}

function round(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}
