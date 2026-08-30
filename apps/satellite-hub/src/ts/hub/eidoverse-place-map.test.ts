import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadEidoversePlaceMap,
  parseEidoversePlaceMap,
  resolveEidoversePlace,
} from "./eidoverse-place-map.js";

const MAPPING = {
  schemaVersion: 1,
  worlds: {
    "demo-world": {
      placeId: "eidoverse:demo-world",
      regions: {
        market: "eidoverse:demo-world:market",
      },
    },
  },
};

test("Eidoverse place map resolves the world default and an optional region overlay", () => {
  const mapping = parseEidoversePlaceMap(MAPPING);

  assert.deepEqual(resolveEidoversePlace(mapping, "demo-world"), {
    placeId: "eidoverse:demo-world",
  });
  assert.deepEqual(resolveEidoversePlace(mapping, "demo-world", "market"), {
    placeId: "eidoverse:demo-world:market",
  });
});

test("Eidoverse place map retains the world default and reports an unmapped region", () => {
  const mapping = parseEidoversePlaceMap(MAPPING);

  assert.deepEqual(resolveEidoversePlace(mapping, "demo-world", "harbor"), {
    placeId: "eidoverse:demo-world",
    contextNote: "Eidoverse region \"harbor\" in world \"demo-world\" is not mapped to a more specific place; using the world's default place.",
  });
});

test("Eidoverse place map fails closed for an unknown world", () => {
  const mapping = parseEidoversePlaceMap(MAPPING);

  assert.deepEqual(resolveEidoversePlace(mapping, "unknown-world", "market"), {});
});

test("Eidoverse place map rejects place IDs outside the canonical places.json token pattern", () => {
  for (const placeId of ["", " leading-space", "contains space", "slash/not-allowed", "x".repeat(129)]) {
    assert.throws(
      () => parseEidoversePlaceMap({
        schemaVersion: 1,
        worlds: {
          "demo-world": { placeId },
        },
      }),
      /must match the canonical places\.json place ID pattern/,
    );
  }

  assert.throws(
    () => parseEidoversePlaceMap({
      schemaVersion: 1,
      worlds: {
        "demo-world": {
          placeId: "eidoverse:demo-world",
          regions: { market: "invalid/region" },
        },
      },
    }),
    /must match the canonical places\.json place ID pattern/,
  );
});

test("Eidoverse place map loader only reads Hub config and leaves places.json untouched", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eidoverse-place-map-"));
  const mappingPath = path.join(directory, "eidoverse-place-map.json");
  const placesPath = path.join(directory, "places.json");
  const placesJson = JSON.stringify({ schemaVersion: 1, places: [] });
  fs.writeFileSync(mappingPath, JSON.stringify(MAPPING));
  fs.writeFileSync(placesPath, placesJson);

  const mapping = loadEidoversePlaceMap(mappingPath);

  assert.equal(mapping?.worlds["demo-world"]?.placeId, "eidoverse:demo-world");
  assert.equal(fs.readFileSync(placesPath, "utf8"), placesJson);
});
