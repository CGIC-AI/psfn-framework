import assert from "node:assert/strict";
import test from "node:test";

import {
  stackChanModelManifest,
  validateStackChanModelManifest,
} from "./assets.js";
import { stackChanProfile } from "./profiles.js";

test("Stack-chan model manifest defines canonical intake and generated preview paths", () => {
  assert.deepEqual(validateStackChanModelManifest(stackChanModelManifest), []);
  assert.equal(stackChanModelManifest.profileId, stackChanProfile.id);
  assert.equal(stackChanModelManifest.assetRoot, "assets/device-studio/stackchan");
  assert.equal(stackChanModelManifest.outputRoot, "dist/device-studio/assets/stackchan");
  assert.equal(stackChanModelManifest.source.status, "source-present");
  assert.equal(stackChanModelManifest.source.license, "Apache-2.0");
  assert.match(stackChanModelManifest.source.expectedVendorAsset, /source\/shell\.stl$/);

  assert(stackChanModelManifest.paths.some((path) => path.role === "source" && path.format === "stl"));
  assert(stackChanModelManifest.paths.some((path) => path.path.endsWith("feet_top.stl")));
  assert(stackChanModelManifest.paths.some((path) => path.path.endsWith("horn.stl")));
  assert(stackChanModelManifest.paths.some((path) => path.role === "normalized" && path.format === "glb"));
});

test("Stack-chan model manifest maps expected renderer parts and joint pivots", () => {
  assert.deepEqual(
    stackChanModelManifest.parts.map((part) => part.id),
    ["body.shell", "head.shell", "display.face", "neck.pan-tilt", "status.rgb"],
  );
  assert.deepEqual(
    stackChanModelManifest.pivots.map((pivot) => `${pivot.jointId}:${pivot.id}`),
    ["head.yaw:pivot.head.yaw", "head.pitch:pivot.head.pitch"],
  );

  const yawPivot = stackChanModelManifest.pivots.find((pivot) => pivot.jointId === "head.yaw");
  assert(yawPivot);
  assert.equal(yawPivot.axis.y, 1);
  assert(yawPivot.childPartIds.includes("head.shell"));
  assert(yawPivot.childPartIds.includes("display.face"));

  const display = stackChanModelManifest.parts.find((part) => part.id === "display.face");
  assert(display);
  assert.equal(display.role, "display");
  assert.equal(display.fallback.bounds.width, 52);
  assert.equal(display.fallback.color, "#111820");
});

test("Stack-chan model manifest stays honest about unverified generated geometry", () => {
  assert.equal(stackChanModelManifest.provenance.source, "host-generated");
  assert.equal(stackChanModelManifest.hardwareVerification.status, "unverified");
  assert(stackChanModelManifest.hardwareVerification.notes?.includes("physical case"));

  for (const pivot of stackChanModelManifest.pivots) {
    assert.equal(pivot.hardwareVerification.status, "unverified");
  }
});

test("Stack-chan model manifest validation catches missing parts and unknown joint pivots", () => {
  const broken = {
    ...stackChanModelManifest,
    parts: stackChanModelManifest.parts.filter((part) => part.id !== "display.face"),
    pivots: [
      {
        ...stackChanModelManifest.pivots[0],
        jointId: "body.spin",
        childPartIds: ["display.face"],
      },
    ],
  };

  const issueText = validateStackChanModelManifest(broken)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("\n");

  assert.match(issueText, /display part/);
  assert.match(issueText, /unknown joint: body\.spin/);
  assert.match(issueText, /unknown child part: display\.face/);
});
