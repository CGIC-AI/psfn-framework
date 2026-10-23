import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import policy from "./credential-policy.json" with { type: "json" };
import { assertStrongHubCredential } from "./credentials.js";

test("packaged Hub credential policy matches the Helm runtime policy", () => {
  const chart = JSON.parse(fs.readFileSync(new URL("../../../../../deploy/helm/psfn/files/credential-policy.json", import.meta.url), "utf8")) as unknown;
  assert.deepEqual(policy, chart);
});

test("Hub credential policy rejects placeholders, repetitions and non-ASCII values", () => {
  for (const value of ["a".repeat(64), "0123456789abcdef".repeat(4), "change-me-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "test ".repeat(10), "π".repeat(40)]) {
    assert.throws(() => assertStrongHubCredential(value, "example"), error => error instanceof Error && !error.message.includes(value));
  }
  assert.doesNotThrow(() => assertStrongHubCredential("Q4fV9mR2tY7aS3dG5hJ0kL1nW_uEoXiCvBN8bZ6cP", "example"));
});
