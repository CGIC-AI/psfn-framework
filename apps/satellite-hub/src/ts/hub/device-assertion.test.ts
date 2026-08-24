import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import type { HubDeviceIdentity } from "./device-registry.js";
import {
  HUB_DEVICE_ASSERTION_HEADER,
  createHubDeviceAssertionIssuer,
} from "./device-assertion.js";

const PRIVATE_KEY_PEM = createPrivateKey({
  key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIBxi3MoZ6dMittBNv2g0RvbmOi9PJuzu5IVCwAL2tIbN", "base64"),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" }).toString();
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1QtSd1BkjN8MfcUdxGshRQsTRWmoPMPmcXtCQfY2Ytk=
-----END PUBLIC KEY-----
`;
const fixture = JSON.parse(fs.readFileSync(
  new URL(
    "../../../../../src/test-support/fixtures/fleet-sso/hub-device-assertion-v1.json",
    import.meta.url,
  ),
  "utf8",
)) as { validToken: string };

const device: HubDeviceIdentity = {
  deviceId: "office-device",
  deviceName: "Office Device",
  satelliteId: "office",
  satelliteName: "Office",
  endpointId: "office-device",
  claimType: "room-satellite",
  credentialSha256: "0".repeat(64),
  enrollmentVersion: 7,
  enrollmentAssurance: "device_credential",
  enrollmentStatus: "active",
  companionId: "11111111-1111-4111-8111-111111111111",
  placeId: "office",
  maxCapabilities: { input: [], output: [], control: [], safety: [] },
  homeAssistantEntityIds: [],
};

test("issues deterministic audience-bound Ed25519 assertions from enrolled authority", () => {
  const issuer = createHubDeviceAssertionIssuer({
    issuer: "psfn-satellite-hub",
    kid: "hub-2026-07",
    audience: "https://fleet.example.test",
    privateKeyPem: PRIVATE_KEY_PEM,
    ttlSeconds: 30,
  });
  const token = issuer.issue({
    device,
    sessionId: "realtime:office-device:session",
    issuedAtSeconds: 1_784_112_400,
    jti: "018f0f10-79b2-4cc7-8c99-0242ac120002",
  });
  const [encodedHeader, encodedClaims, encodedSignature, extra] = token.split(".");
  assert.equal(token, fixture.validToken);
  assert.equal(extra, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8")), {
    ...HUB_DEVICE_ASSERTION_HEADER,
    kid: "hub-2026-07",
  });
  assert.deepEqual(JSON.parse(Buffer.from(encodedClaims!, "base64url").toString("utf8")), {
    iss: "psfn-satellite-hub",
    device_id: "office-device",
    enrollment_version: 7,
    enrollment_assurance: "device_credential",
    place_id: "office",
    aud: "https://fleet.example.test",
    companion_id: "11111111-1111-4111-8111-111111111111",
    session_id: "realtime:office-device:session",
    iat: 1_784_112_400,
    exp: 1_784_112_430,
    jti: "018f0f10-79b2-4cc7-8c99-0242ac120002",
  });
  assert.equal(verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    createPublicKey(PUBLIC_KEY_PEM),
    Buffer.from(encodedSignature!, "base64url"),
  ), true);
  assert.equal(token.includes("PRIVATE KEY"), false);
});

test("refuses revoked enrollment and caller-selected authority fields", () => {
  const issuer = createHubDeviceAssertionIssuer({
    issuer: "psfn-satellite-hub",
    kid: "hub-2026-07",
    audience: "https://fleet.example.test",
    privateKeyPem: PRIVATE_KEY_PEM,
    ttlSeconds: 30,
  });
  assert.throws(() => issuer.issue({
    device: { ...device, enrollmentStatus: "revoked" },
    sessionId: "realtime:office-device",
    issuedAtSeconds: 1_784_112_400,
    jti: "018f0f10-79b2-4cc7-8c99-0242ac120002",
  }), /active device enrollment/);
  assert.equal("audience" in issuer.issue, false);
});

test("rejects signing identities that the Framework verifier cannot accept", () => {
  const base = {
    issuer: "psfn-satellite-hub",
    kid: "hub-2026-07",
    audience: "https://fleet.example.test",
    privateKeyPem: PRIVATE_KEY_PEM,
    ttlSeconds: 30,
  };
  assert.throws(
    () => createHubDeviceAssertionIssuer({ ...base, issuer: "https://mutable.example.test" }),
    /stable identifier characters/,
  );
  assert.throws(
    () => createHubDeviceAssertionIssuer({ ...base, audience: "http://fleet.example.test" }),
    /exact normalized HTTPS origin/,
  );
  assert.throws(
    () => createHubDeviceAssertionIssuer({ ...base, audience: "https://fleet.example.test/" }),
    /exact normalized HTTPS origin/,
  );
});
