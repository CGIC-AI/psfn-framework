import crypto from "node:crypto";
import fs from "node:fs";

import type { SatelliteCapabilities } from "../shared/protocol.js";
import {
  DEFAULT_REALTIME_CAPABILITIES,
  THIN_SHELL_CAPABILITIES,
  VOXTA_VAM_CAPABILITIES,
  type PsfnChannelContext,
} from "./embodied-session.js";

export type SatelliteCapabilityProfile =
  | "voice-only"
  | "text-only"
  | "voxta-avatar"
  | "world-avatar"
  | "vision-capable"
  | "telemetry-only"
  | "mobile-location";

export type SatelliteEndpointClass =
  | "voice"
  | "text"
  | "avatar"
  | "vision"
  | "telemetry"
  | "mobile";

export type SatelliteLocationMode = "static" | "mobile" | "unavailable";

export type SatelliteTelemetryMode = "disabled" | "static" | "periodic" | "event";

export type SatelliteTelemetryCategory =
  | "location"
  | "timezone"
  | "room"
  | "presence"
  | "battery"
  | "health"
  | "device_status"
  | "avatar_state";

export type FrameworkSatelliteCapability =
  | "text"
  | "audio_input"
  | "speech_to_text"
  | "audio_output"
  | "text_to_speech"
  | "vision"
  | "image_upload"
  | "avatar"
  | "avatar_expression"
  | "avatar_action"
  | "location"
  | "timezone"
  | "presence"
  | "health"
  | "battery"
  | "telemetry"
  | "outbound_delivery"
  | "robotics";

export type FrameworkSatelliteTelemetryScope =
  | "location"
  | "timezone"
  | "presence"
  | "health"
  | "battery"
  | "network"
  | "orientation"
  | "ambient"
  | "device"
  | "status";

export interface SatelliteTelemetryConfig {
  mode: SatelliteTelemetryMode;
  categories: SatelliteTelemetryCategory[];
}

export interface PsfnClientCertificateConfig {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
}

export interface PsfnSatelliteClaimConfig {
  namespace: string;
  type: string;
  channelType: string;
  satelliteId: string;
  endpointId: string;
  displayName: string;
  endpointClass: SatelliteEndpointClass;
  locationMode: SatelliteLocationMode;
  capabilityProfile: SatelliteCapabilityProfile;
  telemetry: SatelliteTelemetryConfig;
  tls?: PsfnClientCertificateConfig;
}

export interface SatelliteClaimEnvelope {
  protocolVersion: "satellite-claim.v1";
  claim: {
    namespace: string;
    type: string;
    satelliteId: string;
    endpointId: string;
    sessionId: string;
    threadId: string;
    channelId: string;
    deviceClass: SatelliteEndpointClass;
    displayName: string;
    locationMode: SatelliteLocationMode;
  };
  capabilities: {
    profile: SatelliteCapabilityProfile;
    current: Required<SatelliteCapabilities>;
    activeSatellites: Array<{
      id: string;
      name: string;
      transport: string;
      capabilities: Required<SatelliteCapabilities>;
    }>;
  };
  telemetry: SatelliteTelemetryConfig;
  auth: {
    mode: "none" | "bearer" | "mtls";
    clientCertificateConfigured: boolean;
    clientCertificateFingerprintSha256?: string;
  };
}

interface ProfileDefaults {
  endpointClass: SatelliteEndpointClass;
  locationMode: SatelliteLocationMode;
  capabilities: Required<SatelliteCapabilities>;
  telemetry: SatelliteTelemetryConfig;
}

export const SATELLITE_CLAIM_NAMESPACE = "satellite.endpoint";
export const DEFAULT_PSFN_CHANNEL_TYPE = SATELLITE_CLAIM_NAMESPACE;
export const DEFAULT_SATELLITE_ID = "hub";
export const DEFAULT_ENDPOINT_ID = "hub";
export const DEFAULT_ENDPOINT_DISPLAY_NAME = "PSFN Satellite Hub";
export const DEFAULT_CAPABILITY_PROFILE: SatelliteCapabilityProfile = "voice-only";

export const CAPABILITY_PROFILE_DEFAULTS: Record<SatelliteCapabilityProfile, ProfileDefaults> = {
  "voice-only": {
    endpointClass: "voice",
    locationMode: "static",
    capabilities: DEFAULT_REALTIME_CAPABILITIES,
    telemetry: { mode: "disabled", categories: [] },
  },
  "text-only": {
    endpointClass: "text",
    locationMode: "static",
    capabilities: THIN_SHELL_CAPABILITIES,
    telemetry: { mode: "disabled", categories: [] },
  },
  "voxta-avatar": {
    endpointClass: "avatar",
    locationMode: "static",
    capabilities: VOXTA_VAM_CAPABILITIES,
    telemetry: { mode: "event", categories: ["presence", "avatar_state"] },
  },
  "world-avatar": {
    endpointClass: "avatar",
    locationMode: "static",
    capabilities: {
      input: ["text", "vision_upload"],
      output: ["text", "subtitle", "action"],
      control: ["presence", "session_attach"],
      safety: ["action_allowlist", "confirmation_required"],
    },
    telemetry: { mode: "event", categories: ["presence", "avatar_state"] },
  },
  "vision-capable": {
    endpointClass: "vision",
    locationMode: "static",
    capabilities: {
      input: ["text", "vision_upload"],
      output: ["text", "subtitle"],
      control: ["interrupt", "presence", "session_attach"],
      safety: ["confirmation_required"],
    },
    telemetry: { mode: "event", categories: ["presence", "health"] },
  },
  "telemetry-only": {
    endpointClass: "telemetry",
    locationMode: "static",
    capabilities: {
      input: [],
      output: [],
      control: ["presence"],
      safety: ["local_only"],
    },
    telemetry: { mode: "periodic", categories: ["presence", "health", "device_status"] },
  },
  "mobile-location": {
    endpointClass: "mobile",
    locationMode: "mobile",
    capabilities: {
      input: ["microphone_pcm", "final_transcript", "text", "vision_upload", "wake_event"],
      output: ["text", "subtitle", "streamed_audio"],
      control: ["interrupt", "presence", "session_attach"],
      safety: ["confirmation_required"],
    },
    telemetry: { mode: "event", categories: ["location", "timezone", "presence", "battery", "health"] },
  },
};

export function normalizeSatelliteClaimConfig(input: Partial<PsfnSatelliteClaimConfig> = {}): PsfnSatelliteClaimConfig {
  const capabilityProfile = input.capabilityProfile ?? DEFAULT_CAPABILITY_PROFILE;
  const defaults = CAPABILITY_PROFILE_DEFAULTS[capabilityProfile];
  return {
    namespace: normalizedOr(input.namespace, SATELLITE_CLAIM_NAMESPACE),
    type: normalizedOr(input.type, capabilityProfile),
    channelType: normalizedOr(input.channelType, input.namespace ?? DEFAULT_PSFN_CHANNEL_TYPE),
    satelliteId: normalizedOr(input.satelliteId, DEFAULT_SATELLITE_ID),
    endpointId: normalizedOr(input.endpointId, input.satelliteId ?? DEFAULT_ENDPOINT_ID),
    displayName: normalizedOr(input.displayName, DEFAULT_ENDPOINT_DISPLAY_NAME),
    endpointClass: input.endpointClass ?? defaults.endpointClass,
    locationMode: input.locationMode ?? defaults.locationMode,
    capabilityProfile,
    telemetry: {
      mode: input.telemetry?.mode ?? defaults.telemetry.mode,
      categories: unique(input.telemetry?.categories ?? defaults.telemetry.categories),
    },
    tls: input.tls,
  };
}

export function defaultCapabilitiesForProfile(profile: SatelliteCapabilityProfile): Required<SatelliteCapabilities> {
  const capabilities = CAPABILITY_PROFILE_DEFAULTS[profile].capabilities;
  return {
    input: [...capabilities.input],
    output: [...capabilities.output],
    control: [...capabilities.control],
    safety: [...capabilities.safety],
  };
}

export function buildSatelliteClaimEnvelope(input: {
  config: PsfnSatelliteClaimConfig;
  conversationId: string;
  channel: PsfnChannelContext;
  apiKey?: string;
}): SatelliteClaimEnvelope {
  const source = input.channel.activeSatellites.find((satellite) => satellite.id === input.channel.sourceSatelliteId);
  const identity = input.channel.claimIdentity;
  const currentCapabilities = source?.capabilities ?? defaultCapabilitiesForProfile(input.config.capabilityProfile);
  const fingerprint = certificateFingerprint(input.config.tls?.certPath);
  const clientCertificateConfigured = Boolean(input.config.tls?.certPath && input.config.tls?.keyPath);
  return {
    protocolVersion: "satellite-claim.v1",
    claim: {
      namespace: input.config.namespace,
      type: identity?.claimType ?? input.config.type,
      satelliteId: identity?.satelliteId ?? input.config.satelliteId,
      endpointId: identity?.endpointId ?? input.config.endpointId,
      sessionId: input.channel.sessionId,
      threadId: input.conversationId,
      channelId: input.channel.channelId,
      deviceClass: input.config.endpointClass,
      displayName: identity?.displayName ?? input.config.displayName,
      locationMode: input.config.locationMode,
    },
    capabilities: {
      profile: input.config.capabilityProfile,
      current: cloneCapabilities(currentCapabilities),
      activeSatellites: input.channel.activeSatellites.map((satellite) => ({
        id: satellite.id,
        name: satellite.name,
        transport: satellite.transport,
        capabilities: cloneCapabilities(satellite.capabilities),
      })),
    },
    telemetry: {
      mode: input.config.telemetry.mode,
      categories: [...input.config.telemetry.categories],
    },
    auth: {
      mode: clientCertificateConfigured ? "mtls" : input.apiKey ? "bearer" : "none",
      clientCertificateConfigured,
      ...(fingerprint ? { clientCertificateFingerprintSha256: fingerprint } : {}),
    },
  };
}

export function buildSatelliteRegistryHeaders(input: {
  config: PsfnSatelliteClaimConfig;
  satelliteClaim: SatelliteClaimEnvelope;
}): Record<string, string> {
  const capabilities = frameworkCapabilitiesForSatelliteCapabilities(
    input.satelliteClaim.capabilities.current,
    input.config.capabilityProfile,
  );
  const telemetryScopes = frameworkTelemetryScopesForConfig(input.config.telemetry);
  const headers: Record<string, string> = {
    "X-PSFN-Satellite-Claim-Type": input.satelliteClaim.claim.type,
    "X-PSFN-Satellite-ID": input.satelliteClaim.claim.satelliteId,
    "X-PSFN-Satellite-Endpoint-ID": input.satelliteClaim.claim.endpointId,
    "X-PSFN-Satellite-Session-ID": input.satelliteClaim.claim.sessionId,
    "X-PSFN-Satellite-Thread-ID": input.satelliteClaim.claim.threadId,
  };
  if (capabilities.length) {
    headers["X-PSFN-Satellite-Capabilities"] = capabilities.join(",");
  }
  if (telemetryScopes.length) {
    headers["X-PSFN-Satellite-Telemetry-Scopes"] = telemetryScopes.join(",");
  }
  if (input.satelliteClaim.auth.clientCertificateFingerprintSha256) {
    headers["X-PSFN-Client-Cert-Fingerprint-SHA256"] = input.satelliteClaim.auth.clientCertificateFingerprintSha256;
  }
  return headers;
}

export function frameworkCapabilitiesForSatelliteCapabilities(
  capabilities: SatelliteCapabilities,
  profile?: SatelliteCapabilityProfile,
): FrameworkSatelliteCapability[] {
  const input = new Set(capabilities.input ?? []);
  const output = new Set(capabilities.output ?? []);
  const control = new Set(capabilities.control ?? []);
  const mapped = new Set<FrameworkSatelliteCapability>();

  if (input.has("text") || output.has("text") || output.has("subtitle")) {
    mapped.add("text");
  }
  if (input.has("microphone_pcm") || input.has("wake_event")) {
    mapped.add("audio_input");
  }
  if (input.has("final_transcript")) {
    mapped.add("speech_to_text");
  }
  if (output.has("streamed_audio") || output.has("local_file_audio")) {
    mapped.add("audio_output");
    mapped.add("text_to_speech");
  }
  if (input.has("vision_upload")) {
    mapped.add("vision");
    mapped.add("image_upload");
  }
  if (output.has("animation") || output.has("expression") || output.has("action") || output.has("gaze")) {
    mapped.add("avatar");
  }
  if (output.has("expression")) {
    mapped.add("avatar_expression");
  }
  if (output.has("action")) {
    mapped.add("avatar_action");
  }
  if (profile === "world-avatar" && control.has("presence")) {
    mapped.add("presence");
  }
  return [...mapped];
}

export function frameworkTelemetryScopesForConfig(
  telemetry: SatelliteTelemetryConfig,
): FrameworkSatelliteTelemetryScope[] {
  if (telemetry.mode === "disabled") {
    return [];
  }
  const mapped = new Set<FrameworkSatelliteTelemetryScope>();
  for (const category of telemetry.categories) {
    switch (category) {
      case "location":
      case "timezone":
      case "presence":
      case "battery":
      case "health":
        mapped.add(category);
        break;
      case "device_status":
        mapped.add("device");
        mapped.add("status");
        break;
      case "avatar_state":
        mapped.add("status");
        break;
      case "room":
        break;
    }
  }
  return [...mapped];
}

function cloneCapabilities(capabilities: Required<SatelliteCapabilities>): Required<SatelliteCapabilities> {
  return {
    input: [...capabilities.input],
    output: [...capabilities.output],
    control: [...capabilities.control],
    safety: [...capabilities.safety],
  };
}

function certificateFingerprint(certPath: string | undefined): string | undefined {
  if (!certPath) {
    return undefined;
  }
  const cert = fs.readFileSync(certPath);
  return crypto.createHash("sha256").update(cert).digest("hex");
}

function normalizedOr(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean) as T[])];
}
