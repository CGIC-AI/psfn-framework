import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

import type { SatelliteCapabilities } from "../shared/protocol.js";

const INPUT_CAPABILITIES = ["text", "microphone_pcm", "final_transcript", "vision_upload", "wake_event"] as const;
const OUTPUT_CAPABILITIES = [
  "text", "subtitle", "streamed_audio", "local_file_audio", "animation", "action",
  "expression", "gaze", "servo", "artifact", "tool_activity",
] as const;
const CONTROL_CAPABILITIES = ["interrupt", "mute", "sleep_wake", "presence", "session_attach", "touch", "approvals"] as const;
const SAFETY_CAPABILITIES = ["action_allowlist", "confirmation_required", "local_only"] as const;

export interface HubDeviceIdentity {
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  satelliteName: string;
  endpointId: string;
  claimType: string;
  credentialSha256: string;
  enrollmentVersion: number;
  enrollmentAssurance: "device_credential";
  enrollmentStatus: "active" | "revoked";
  companionId: string;
  placeId?: string;
  maxCapabilities: Required<SatelliteCapabilities>;
  homeAssistantEntityIds: string[];
}

export interface HubDeviceRegistry {
  schemaVersion: 1;
  devices: HubDeviceIdentity[];
}

export function loadHubDeviceRegistry(filePath: string | undefined): HubDeviceRegistry | null {
  if (!filePath) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.devices) || raw.devices.length === 0) {
    throw new Error("Hub device registry must use schemaVersion 1 and contain at least one device");
  }
  const devices = raw.devices.map((value, index) => parseDevice(value, index));
  assertUnique(devices, "deviceId", (device) => device.deviceId);
  assertUnique(devices, "satelliteId/endpointId", (device) => `${device.satelliteId}/${device.endpointId}`);
  assertUnique(devices, "credentialSha256", (device) => device.credentialSha256);
  return { schemaVersion: 1, devices };
}

export function authenticateHubDevice(
  registry: HubDeviceRegistry,
  credential: string | undefined,
): HubDeviceIdentity | null {
  if (!credential) return null;
  const digest = createHash("sha256").update(credential, "utf8").digest();
  for (const device of registry.devices) {
    if (device.enrollmentStatus !== "active") continue;
    const expected = Buffer.from(device.credentialSha256, "hex");
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) return device;
  }
  return null;
}

export function intersectCapabilities(
  requested: SatelliteCapabilities | undefined,
  maximum: Required<SatelliteCapabilities>,
): Required<SatelliteCapabilities> {
  if (!requested) return cloneCapabilities(maximum);
  authorizeRequested(requested.safety, maximum.safety, SAFETY_CAPABILITIES, "safety");
  return {
    input: authorizeRequested(requested.input, maximum.input, INPUT_CAPABILITIES, "input"),
    output: authorizeRequested(requested.output, maximum.output, OUTPUT_CAPABILITIES, "output"),
    control: authorizeRequested(requested.control, maximum.control, CONTROL_CAPABILITIES, "control"),
    safety: [...maximum.safety],
  };
}

function parseDevice(value: unknown, index: number): HubDeviceIdentity {
  if (!isRecord(value)) throw new Error(`Hub device registry devices[${index}] must be an object`);
  const field = (name: string): string => requiredString(value[name], `devices[${index}].${name}`);
  const credentialSha256 = field("credentialSha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(credentialSha256)) {
    throw new Error(`devices[${index}].credentialSha256 must be a SHA-256 hex digest`);
  }
  if (!isRecord(value.maxCapabilities)) {
    throw new Error(`devices[${index}].maxCapabilities must be an object`);
  }
  return {
    deviceId: field("deviceId"),
    deviceName: field("deviceName"),
    satelliteId: field("satelliteId"),
    satelliteName: field("satelliteName"),
    endpointId: field("endpointId"),
    claimType: field("claimType"),
    credentialSha256,
    enrollmentVersion: requiredPositiveInteger(
      value.enrollmentVersion,
      `devices[${index}].enrollmentVersion`,
    ),
    enrollmentAssurance: parseEnrollmentAssurance(
      value.enrollmentAssurance,
      `devices[${index}].enrollmentAssurance`,
    ),
    enrollmentStatus: parseEnrollmentStatus(
      value.enrollmentStatus,
      `devices[${index}].enrollmentStatus`,
    ),
    companionId: requiredUuid(value.companionId, `devices[${index}].companionId`),
    ...(value.placeId === undefined
      ? {}
      : { placeId: requiredString(value.placeId, `devices[${index}].placeId`) }),
    maxCapabilities: parseMaximumCapabilities(value.maxCapabilities, index),
    homeAssistantEntityIds: parseEntityIds(value.homeAssistantEntityIds, index),
  };
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

function parseEnrollmentAssurance(value: unknown, field: string): "device_credential" {
  if (value !== "device_credential") throw new Error(`${field} must be device_credential`);
  return value;
}

function parseEnrollmentStatus(value: unknown, field: string): "active" | "revoked" {
  if (value !== "active" && value !== "revoked") {
    throw new Error(`${field} must be active or revoked`);
  }
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed)) {
    throw new Error(`${field} must be a lowercase RFC-4122 UUID`);
  }
  return parsed;
}

function parseEntityIds(value: unknown, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`devices[${index}].homeAssistantEntityIds must be an array`);
  }
  const entityIds: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(item)) {
      throw new Error(`devices[${index}].homeAssistantEntityIds contains an invalid entity id`);
    }
    if (!entityIds.includes(item)) entityIds.push(item);
  }
  return entityIds;
}

function parseMaximumCapabilities(
  value: Record<string, unknown>,
  index: number,
): Required<SatelliteCapabilities> {
  const prefix = `devices[${index}].maxCapabilities`;
  return {
    input: parseCapabilityList(value.input, INPUT_CAPABILITIES, `${prefix}.input`),
    output: parseCapabilityList(value.output, OUTPUT_CAPABILITIES, `${prefix}.output`),
    control: parseCapabilityList(value.control, CONTROL_CAPABILITIES, `${prefix}.control`),
    safety: parseCapabilityList(value.safety, SAFETY_CAPABILITIES, `${prefix}.safety`),
  };
}

function parseCapabilityList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new Error(`${field} contains an unsupported capability`);
    }
    if (!result.includes(item as T)) result.push(item as T);
  }
  return result;
}

function authorizeRequested<T extends string>(
  requested: readonly T[] | undefined,
  maximum: readonly T[],
  allowed: readonly T[],
  category: string,
): T[] {
  if (requested === undefined) return [];
  const normalized = parseCapabilityList(requested, allowed, `hello.capabilities.${category}`);
  for (const capability of normalized) {
    if (!maximum.includes(capability)) {
      throw new Error(`hello requests unauthorized ${category} capability`);
    }
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function assertUnique<T>(values: readonly T[], label: string, key: (value: T) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const item = key(value);
    if (seen.has(item)) throw new Error(`Hub device registry has duplicate ${label}: ${item}`);
    seen.add(item);
  }
}

function cloneCapabilities(capabilities: Required<SatelliteCapabilities>): Required<SatelliteCapabilities> {
  return {
    input: [...capabilities.input],
    output: [...capabilities.output],
    control: [...capabilities.control],
    safety: [...capabilities.safety],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
