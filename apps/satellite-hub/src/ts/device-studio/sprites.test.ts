import assert from "node:assert/strict";
import test from "node:test";

import { stackChanProfile, waveshareEsp32S3RoundTouchProfile } from "./profiles.js";
import {
  decodeRgbaPng,
  encodeRgbaPng,
  packDeviceSpriteSheet,
  SpriteSheetPackingError,
} from "./sprites.js";
import type { RgbaPngImage, SpriteSourceFrame } from "./sprites.js";

test("sprite packer sorts frames deterministically and writes manifest schema", () => {
  const frames: SpriteSourceFrame[] = [
    makeFrame("wide", "viseme", 2, 1, [90, 10, 20, 255]),
    makeFrame("happy", "expression", 2, 1, [20, 30, 40, 255]),
    makeFrame("blink", "expression", 1, 1, [10, 20, 30, 255]),
    makeFrame("a", "viseme", 1, 1, [200, 0, 0, 255]),
  ];

  const first = packDeviceSpriteSheet({
    profileId: stackChanProfile.id,
    atlasId: "test.atlas",
    frames,
  });
  const second = packDeviceSpriteSheet({
    profileId: stackChanProfile.id,
    atlasId: "test.atlas",
    frames: [...frames].reverse(),
  });

  assert.deepEqual(first.manifest.frames.map((frame) => `${frame.kind}:${frame.id}`), [
    "expression:blink",
    "expression:happy",
    "viseme:a",
    "viseme:wide",
  ]);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.atlasPng, second.atlasPng);
  assert.equal(first.manifest.schemaVersion, 1);
  assert.equal(first.manifest.profile.id, stackChanProfile.id);
  assert.equal(first.manifest.profile.display.width, 320);
  assert.equal(first.manifest.profile.display.height, 240);
  assert.equal(first.manifest.profile.display.shape, "rectangular");
  assert.equal(first.manifest.atlas.id, "test.atlas");
  assert.equal(first.manifest.atlas.width, 320);
  assert.equal(first.manifest.atlas.height, 1);
  assert.match(first.manifest.atlas.pngContentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.frames[0]?.atlasRect.x, 0);
  assert.equal(first.manifest.frames[1]?.atlasRect.x, 1);
  assert.equal(first.manifest.frames[2]?.atlasRect.x, 3);
  assert.equal(first.manifest.frames[3]?.atlasRect.x, 4);
  assert.equal(first.manifest.frames[0]?.source.provenance?.source, "test-fixture");
  assert.match(first.manifest.frames[0]?.source.contentHash ?? "", /^[a-f0-9]{64}$/);
});

test("sprite packer preserves actual RGBA pixels in atlas output", () => {
  const red = [255, 0, 0, 255] as const;
  const green = [0, 255, 0, 255] as const;
  const blue = [0, 0, 255, 255] as const;
  const transparent = [0, 0, 0, 0] as const;
  const result = packDeviceSpriteSheet({
    profileId: stackChanProfile.id,
    frames: [
      makeFrameFromPixels("b", "expression", 2, 2, [...red, ...green, ...blue, ...transparent]),
      makeFrame("a", "expression", 1, 1, [20, 30, 40, 255]),
    ],
  });

  const atlas = decodeRgbaPng(result.atlasPng);
  assert.equal(atlas.width, 320);
  assert.equal(atlas.height, 2);

  assertPixel(atlas, 0, 0, [20, 30, 40, 255]);
  assertPixel(atlas, 1, 0, red);
  assertPixel(atlas, 2, 0, green);
  assertPixel(atlas, 1, 1, blue);
  assertPixel(atlas, 2, 1, transparent);
});

test("round LCD profile includes round-safe clipping metadata", () => {
  const result = packDeviceSpriteSheet({
    profileId: waveshareEsp32S3RoundTouchProfile.id,
    frames: [makeFrame("neutral", "expression", 3, 3, [1, 2, 3, 255])],
  });

  assert.equal(result.manifest.profile.display.width, 360);
  assert.equal(result.manifest.profile.display.height, 360);
  assert.equal(result.manifest.profile.display.shape, "round");
  assert.deepEqual(result.manifest.profile.display.safeArea, {
    x: 0,
    y: 0,
    width: 360,
    height: 360,
  });
  assert.deepEqual(result.manifest.profile.display.roundClip, {
    shape: "circle",
    centerX: 180,
    centerY: 180,
    radius: 180,
  });
  assert.deepEqual(result.manifest.frames[0]?.roundClip, result.manifest.profile.display.roundClip);
});

test("sprite packer rejects malformed inputs", () => {
  const duplicate = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: stackChanProfile.id,
      frames: [
        makeFrame("neutral", "expression", 1, 1, [1, 2, 3, 255]),
        makeFrame("neutral", "expression", 1, 1, [4, 5, 6, 255]),
      ],
    });
  });
  assert(duplicate.issues.some((issue) => issue.message.includes("Duplicate sprite frame")));

  const unsupportedProfile = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: "missing.profile",
      frames: [makeFrame("neutral", "expression", 1, 1, [1, 2, 3, 255])],
    });
  });
  assert(unsupportedProfile.issues.some((issue) => issue.path === "profileId"));

  const badExpectedDimensions = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: stackChanProfile.id,
      frames: [{
        ...makeFrame("neutral", "expression", 2, 2, [1, 2, 3, 255]),
        expectedWidth: 3,
      }],
    });
  });
  assert(badExpectedDimensions.issues.some((issue) => issue.path.endsWith(".expectedWidth")));

  const malformedPng = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: stackChanProfile.id,
      frames: [{
        id: "neutral",
        kind: "expression",
        png: new Uint8Array([1, 2, 3]),
      }],
    });
  });
  assert(malformedPng.issues.some((issue) => issue.message.includes("too short")));
});

test("sprite packer rejects profile-incompatible frame dimensions", () => {
  const tooWide = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: stackChanProfile.id,
      frames: [makeFrame("huge", "expression", 321, 1, [1, 2, 3, 255])],
    });
  });
  assert(tooWide.issues.some((issue) => issue.message.includes("exceeds")));

  const tooTall = throwsPackingError(() => {
    packDeviceSpriteSheet({
      profileId: waveshareEsp32S3RoundTouchProfile.id,
      frames: [makeFrame("huge", "viseme", 1, 361, [1, 2, 3, 255])],
    });
  });
  assert(tooTall.issues.some((issue) => issue.message.includes("exceeds")));
});

function throwsPackingError(fn: () => void): SpriteSheetPackingError {
  try {
    fn();
  } catch (error) {
    assert(error instanceof SpriteSheetPackingError);
    return error;
  }
  assert.fail("Expected SpriteSheetPackingError");
}

function makeFrame(
  id: string,
  kind: "expression" | "viseme",
  width: number,
  height: number,
  pixel: readonly [number, number, number, number],
): SpriteSourceFrame {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set(pixel, offset);
  }
  return makeFrameFromPixels(id, kind, width, height, data);
}

function makeFrameFromPixels(
  id: string,
  kind: "expression" | "viseme",
  width: number,
  height: number,
  pixels: Iterable<number>,
): SpriteSourceFrame {
  return {
    id,
    kind,
    png: encodeRgbaPng({
      width,
      height,
      data: Uint8Array.from(pixels),
    }),
    provenance: {
      label: `${kind}:${id}`,
      source: "test-fixture",
    },
  };
}

function assertPixel(
  image: RgbaPngImage,
  x: number,
  y: number,
  expected: readonly [number, number, number, number],
): void {
  const offset = ((y * image.width) + x) * 4;
  assert.deepEqual([...image.data.subarray(offset, offset + 4)], [...expected]);
}
