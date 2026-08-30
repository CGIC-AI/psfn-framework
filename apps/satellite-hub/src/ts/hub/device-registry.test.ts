import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SatelliteCapabilities } from "../shared/protocol.js";
import {
  authenticateHubDevice,
  intersectCapabilities,
  loadHubDeviceRegistry,
  loadHubDeviceRegistryAuthority,
  requireCurrentHubDeviceEnrollment,
} from "./device-registry.js";

test("device registry authenticates a credential without storing plaintext", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-device-registry-"));
  const filePath = path.join(directory, "devices.json");
  const credential = "bedroom-device-secret";
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    devices: [{
      deviceId: "bedroom-pi",
      deviceName: "Bedroom Pi",
      satelliteId: "bedroom",
      satelliteName: "Bedroom",
      endpointId: "bedroom-pi",
      claimType: "room-satellite",
      credentialSha256: createHash("sha256").update(credential).digest("hex"),
      enrollmentVersion: 1,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      placeId: "bedroom",
      maxCapabilities: {
        input: ["text", "microphone_pcm"],
        output: ["text", "streamed_audio"],
        control: ["interrupt", "presence"],
        safety: ["local_only"],
      },
      homeAssistantEntityIds: ["light.main_bedroom", "fan.main_bedroom_2"],
    }],
  }));

  const registry = loadHubDeviceRegistry(filePath);
  assert.ok(registry);
  assert.equal(authenticateHubDevice(registry, credential)?.satelliteId, "bedroom");
  assert.deepEqual(authenticateHubDevice(registry, credential)?.homeAssistantEntityIds, [
    "light.main_bedroom",
    "fan.main_bedroom_2",
  ]);
  assert.equal(authenticateHubDevice(registry, "wrong"), null);
  assert.equal(authenticateHubDevice({
    ...registry,
    devices: registry.devices.map(device => ({ ...device, enrollmentStatus: "revoked" as const })),
  }, credential), null);
  assert.equal(JSON.stringify(registry).includes(credential), false);
});

test("file-backed device authority reloads enrollment state and fences stale attachments", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-device-authority-"));
  const filePath = path.join(directory, "devices.json");
  const device = {
    deviceId: "bedroom-pi",
    deviceName: "Bedroom Pi",
    satelliteId: "bedroom",
    satelliteName: "Bedroom",
    endpointId: "bedroom-pi",
    claimType: "room-satellite",
    credentialSha256: "0".repeat(64),
    enrollmentVersion: 1,
    enrollmentAssurance: "device_credential" as const,
    enrollmentStatus: "active" as const,
    companionId: "11111111-1111-4111-8111-111111111111",
    placeId: "bedroom",
    maxCapabilities: { input: ["text"], output: ["text"], control: [], safety: ["local_only"] },
    homeAssistantEntityIds: [],
  };
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, devices: [device] }));
  const authority = loadHubDeviceRegistryAuthority(filePath);
  assert.ok(authority);
  const attached = authority.readCurrent().devices[0]!;

  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    devices: [{ ...device, enrollmentVersion: 2 }],
  }));

  assert.throws(
    () => requireCurrentHubDeviceEnrollment(authority, attached),
    /enrollment version changed/,
  );
  assert.equal(authority.readCurrent().devices[0]?.enrollmentVersion, 2);
});

test("capability authorization preserves safety and rejects escalation", () => {
  const maximum = {
    input: ["text", "microphone_pcm"],
    output: ["text", "streamed_audio", "emotion"],
    control: ["interrupt", "presence"],
    safety: ["local_only"],
  } satisfies Required<SatelliteCapabilities>;
  assert.deepEqual(intersectCapabilities({
    input: ["text"],
    output: ["emotion"],
    control: ["presence"],
    safety: [],
  }, maximum), {
    input: ["text"],
    output: ["emotion"],
    control: ["presence"],
    safety: ["local_only"],
  });
  assert.throws(
    () => intersectCapabilities({ control: ["sleep_wake"] }, maximum),
    /unauthorized control capability/,
  );
});

test("device registry preserves explicit empty maximum capability lists", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-device-registry-empty-"));
  const filePath = path.join(directory, "devices.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    devices: [{
      deviceId: "sensor",
      deviceName: "Sensor",
      satelliteId: "hall",
      satelliteName: "Hall",
      endpointId: "sensor",
      claimType: "room-sensor",
      credentialSha256: "0".repeat(64),
      enrollmentVersion: 1,
      enrollmentAssurance: "device_credential",
      enrollmentStatus: "active",
      companionId: "11111111-1111-4111-8111-111111111111",
      maxCapabilities: { input: [], output: [], control: [], safety: [] },
    }],
  }));

  assert.deepEqual(loadHubDeviceRegistry(filePath)?.devices[0]?.maxCapabilities, {
    input: [], output: [], control: [], safety: [],
  });
  assert.deepEqual(loadHubDeviceRegistry(filePath)?.devices[0]?.homeAssistantEntityIds, []);
});
