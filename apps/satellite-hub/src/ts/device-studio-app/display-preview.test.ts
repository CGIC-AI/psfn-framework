import assert from "node:assert/strict";
import test from "node:test";

import { sampleBehaviorRenderState } from "../device-studio/behavior.js";
import { danceSingAlongBehavior, happyLaughingBehavior } from "../device-studio/fixtures.js";
import type { DeviceProfile } from "../device-studio/model.js";
import { stackChanProfile, waveshareEsp32S3RoundTouchProfile } from "../device-studio/profiles.js";
import {
  createDisplayPreviewSnapshot,
  formatProfilePreviewMeta,
  mapPointerToDisplayTouch,
} from "./display-preview.js";

test("display preview snapshot keeps rectangular LCD aspect stable", () => {
  const renderState = sampleBehaviorRenderState(happyLaughingBehavior, 280, {
    profile: stackChanProfile,
  });

  const snapshot = createDisplayPreviewSnapshot(stackChanProfile, renderState);

  assert.equal(snapshot.display.width, 320);
  assert.equal(snapshot.display.height, 240);
  assert.equal(snapshot.display.shape, "rectangular");
  assert.equal(snapshot.display.aspectRatio, "4 / 3");
  assert.equal(snapshot.display.clip, "inset");
  assert.equal(snapshot.expression.id, "laughing");
  assert.equal(snapshot.expression.eyes, "closed");
  assert.equal(snapshot.expression.mouth, "open");
  assert.equal(snapshot.viseme.id, "wide");
  assert.match(formatProfilePreviewMeta(stackChanProfile), /320 x 240 \/ rectangular \/ touch 2 pts/);
});

test("round Waveshare preview uses circular clipping and reports degraded channels", () => {
  const renderState = sampleBehaviorRenderState(danceSingAlongBehavior, 500, {
    profile: waveshareEsp32S3RoundTouchProfile,
  });

  const snapshot = createDisplayPreviewSnapshot(waveshareEsp32S3RoundTouchProfile, renderState);

  assert.equal(snapshot.display.shape, "round");
  assert.equal(snapshot.display.aspectRatio, "1 / 1");
  assert.equal(snapshot.display.clip, "circle");
  assert.equal(snapshot.touch.enabled, true);
  assert(snapshot.channels.ignored.some((ignored) => ignored.channel === "joints"));
  assert(snapshot.channels.ignored.some((ignored) => ignored.channel === "leds"));
  assert.match(snapshot.channels.ignoredLabel, /joints/);
  assert.match(snapshot.channels.ignoredLabel, /leds/);
});

test("touch mapping honors capability support and round screen clipping", () => {
  const bounds = { left: 10, top: 20, width: 200, height: 200 };
  const center = mapPointerToDisplayTouch(waveshareEsp32S3RoundTouchProfile, bounds, {
    clientX: 110,
    clientY: 120,
  });
  const corner = mapPointerToDisplayTouch(waveshareEsp32S3RoundTouchProfile, bounds, {
    clientX: 10,
    clientY: 20,
  });
  const noTouchProfile: DeviceProfile = {
    ...waveshareEsp32S3RoundTouchProfile,
    id: "test.no-touch",
    touch: {
      supported: false,
    },
  };

  assert.deepEqual(center, {
    normalized: { x: 0.5, y: 0.5 },
    pixel: { x: 180, y: 180 },
  });
  assert.equal(corner, undefined);
  assert.equal(mapPointerToDisplayTouch(noTouchProfile, bounds, { clientX: 110, clientY: 120 }), undefined);
});
