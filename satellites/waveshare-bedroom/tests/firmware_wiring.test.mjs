import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const targetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preparedProfile = readFileSync(
  path.join(targetRoot, ".generated", "upstream-profile.yaml"),
  "utf8",
);
const localProfile = readFileSync(
  path.join(targetRoot, "esphome", "bedroom-satellite.yaml"),
  "utf8",
);

function preparedBlock(start, end) {
  const startIndex = preparedProfile.indexOf(start);
  assert.notEqual(startIndex, -1, `prepared profile is missing ${start.trim()}`);
  const endIndex = preparedProfile.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `prepared profile is missing ${end.trim()}`);
  return preparedProfile.slice(startIndex, endIndex);
}

test("prepared touch callback dispatches a bounded headpat", () => {
  const touchscreen = preparedBlock("touchscreen:\n", "font:\n");

  assert.match(touchscreen, /psfn::satellite::Gesture::Tap/);
  assert.match(touchscreen, /touch\.x/);
  assert.match(touchscreen, /touch\.y/);
  assert.match(touchscreen, /InteractionAction::Headpat/);
  assert.match(touchscreen, /id\(headpat_feedback\)\.execute\(\)/);
  assert.match(touchscreen, /id\(headpat_signal\)\.publish_state\(true\)/);
});

test("idle face provides immediate local headpat feedback", () => {
  const idlePage = preparedBlock("    - id: idle_page\n", "    - id: listening_page\n");

  assert.match(idlePage, /id: headpat_feedback_label/);
  assert.match(idlePage, /text: "Headpat!"/);
  assert.match(localProfile, /- id: headpat_feedback\n/);
  assert.match(localProfile, /lvgl\.widget\.show: headpat_feedback_label/);
  assert.match(localProfile, /lvgl\.widget\.hide: headpat_feedback_label/);
});

test("headpats emit one bounded native-API signal pulse", () => {
  assert.match(localProfile, /platform: template\n\s+id: headpat_signal/);
  assert.match(localProfile, /id\(headpat_signal\)\.publish_state\(false\)/);
});
