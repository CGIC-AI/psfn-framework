import type { SatelliteCapabilities } from "../shared/protocol.js";
import type { HubDeviceAssertionAuthority } from "./device-assertion.js";

export const DEFAULT_PSFN_CHANNEL_TYPE = "satellite.endpoint";

export const DEFAULT_REALTIME_CAPABILITIES: Required<SatelliteCapabilities> = {
  input: ["microphone_pcm", "final_transcript", "text", "wake_event"],
  output: ["text", "subtitle", "streamed_audio"],
  control: ["interrupt", "presence", "session_attach"],
  safety: [],
};

export const THIN_SHELL_CAPABILITIES: Required<SatelliteCapabilities> = {
  input: ["text"],
  output: ["text", "subtitle"],
  control: ["interrupt", "session_attach"],
  safety: [],
};

export const VOXTA_VAM_CAPABILITIES: Required<SatelliteCapabilities> = {
  input: ["text", "vision_upload"],
  output: ["text", "subtitle", "local_file_audio", "animation", "action", "expression"],
  control: ["interrupt", "presence", "session_attach"],
  safety: ["action_allowlist", "local_only"],
};

export interface AttachedSatellite {
  id: string;
  name: string;
  transport: "websocket" | "mcp";
  capabilities: Required<SatelliteCapabilities>;
  attachedAt: string;
  updatedAt: string;
}

export interface EmbodiedSession {
  sessionId: string;
  channelType: string;
  channelId: string;
  satellites: AttachedSatellite[];
  claimIdentities?: Record<string, NonNullable<PsfnChannelContext["claimIdentity"]>>;
  deviceAuthorities?: Record<string, HubDeviceAssertionAuthority>;
  createdAt: string;
  updatedAt: string;
}

export interface PsfnChannelContext {
  sessionId: string;
  channelType: string;
  channelId: string;
  sourceSatelliteId: string;
  sourceSatelliteName: string;
  claimIdentity?: {
    satelliteId: string;
    endpointId: string;
    claimType: string;
    displayName: string;
  };
  deviceAuthority?: HubDeviceAssertionAuthority;
  /** Hub-owned situated place resolved from a trusted device/world mapping. */
  placeId?: string;
  activeSatellites: Array<{
    id: string;
    name: string;
    transport: AttachedSatellite["transport"];
    capabilities: Required<SatelliteCapabilities>;
  }>;
  visionCaptures?: VisionCaptureMetadata[];
  visionCaptureImages?: VisionCaptureImage[];
  contextNotes?: Array<{
    key: string;
    text: string;
  }>;
}

export interface VisionCaptureMetadata {
  requestId: string;
  sessionId: string;
  source: string;
  label: string;
  mimeType: string;
  filePath: string;
  bytes: number;
  capturedAt: string;
}

export interface VisionCaptureImage extends VisionCaptureMetadata {
  dataBase64: string;
}

export interface AttachSatelliteInput {
  sessionId: string;
  channelId?: string;
  satelliteId: string;
  satelliteName: string;
  transport?: AttachedSatellite["transport"];
  capabilities?: SatelliteCapabilities;
  claimIdentity?: PsfnChannelContext["claimIdentity"];
  deviceAuthority?: HubDeviceAssertionAuthority;
}

export type SatelliteAttachmentOwnership = symbol;

export class EmbodiedSessionRegistry {
  private readonly sessions = new Map<string, EmbodiedSession>();
  private readonly attachmentOwners = new Map<string, Map<string, SatelliteAttachmentOwnership>>();

  constructor(private readonly channelType: string = DEFAULT_PSFN_CHANNEL_TYPE) {}

  attachSatellite(input: AttachSatelliteInput): {
    session: EmbodiedSession;
    satellite: AttachedSatellite;
    ownership: SatelliteAttachmentOwnership;
  } {
    const sessionId = normalizeRequired(input.sessionId, "sessionId");
    const satelliteId = normalizeRequired(input.satelliteId, "satelliteId");
    const now = new Date().toISOString();
    const current = this.sessions.get(sessionId);
    const channelId = normalizeOptional(input.channelId) ?? current?.channelId ?? deriveChannelId(this.channelType, sessionId);
    const satellite: AttachedSatellite = {
      id: satelliteId,
      name: normalizeOptional(input.satelliteName) ?? satelliteId,
      transport: input.transport ?? "websocket",
      capabilities: normalizeCapabilities(input.capabilities),
      attachedAt: current?.satellites.find((item) => item.id === satelliteId)?.attachedAt ?? now,
      updatedAt: now,
    };
    const satellites = [
      ...(current?.satellites.filter((item) => item.id !== satelliteId) ?? []),
      satellite,
    ];
    const session: EmbodiedSession = {
      sessionId,
      channelType: this.channelType,
      channelId,
      satellites,
      ...((current?.claimIdentities || input.claimIdentity) ? {
        claimIdentities: {
          ...(current?.claimIdentities ?? {}),
          ...(input.claimIdentity ? { [satelliteId]: input.claimIdentity } : {}),
        },
      } : {}),
      ...((current?.deviceAuthorities || input.deviceAuthority) ? {
        deviceAuthorities: {
          ...(current?.deviceAuthorities ?? {}),
          ...(input.deviceAuthority ? { [satelliteId]: input.deviceAuthority } : {}),
        },
      } : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const ownership = Symbol(`satellite-attachment:${sessionId}:${satelliteId}`);
    const owners = new Map(this.attachmentOwners.get(sessionId));
    owners.set(satelliteId, ownership);
    this.sessions.set(sessionId, session);
    this.attachmentOwners.set(sessionId, owners);
    return { session, satellite, ownership };
  }

  getContext(
    sessionId: string,
    sourceSatelliteId: string,
    ownership?: SatelliteAttachmentOwnership,
  ): PsfnChannelContext {
    const currentOwnership = this.attachmentOwners.get(sessionId)?.get(sourceSatelliteId);
    // ubs:ignore — these are opaque in-process Symbol references, not attacker-supplied secret bytes.
    if (ownership && currentOwnership !== ownership) {
      throw new Error(`Satellite attachment is not current: ${sessionId}/${sourceSatelliteId}`);
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Satellite is not attached: ${sessionId}/${sourceSatelliteId}`);
    }
    const source = session.satellites.find((satellite) => satellite.id === sourceSatelliteId);
    if (!source) {
      throw new Error(`Satellite is not attached: ${sessionId}/${sourceSatelliteId}`);
    }
    return contextFromSession(session, source);
  }

  getSession(sessionId: string): EmbodiedSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  detachSatellite(
    sessionId: string,
    satelliteId: string,
    ownership: SatelliteAttachmentOwnership,
  ): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    const owners = this.attachmentOwners.get(sessionId);
    // ubs:ignore — these are opaque in-process Symbol references, not attacker-supplied secret bytes.
    if (owners?.get(satelliteId) !== ownership) return false;
    const satellites = current.satellites.filter(satellite => satellite.id !== satelliteId);
    if (satellites.length === current.satellites.length) return false;
    if (satellites.length === 0) {
      this.sessions.delete(sessionId);
      this.attachmentOwners.delete(sessionId);
      return true;
    }
    owners.delete(satelliteId);
    const claimIdentities = { ...current.claimIdentities };
    const deviceAuthorities = { ...current.deviceAuthorities };
    delete claimIdentities[satelliteId];
    delete deviceAuthorities[satelliteId];
    const updated: EmbodiedSession = {
      ...current,
      satellites,
      claimIdentities,
      deviceAuthorities,
      updatedAt: new Date().toISOString(),
    };
    if (Object.keys(claimIdentities).length === 0) delete updated.claimIdentities;
    if (Object.keys(deviceAuthorities).length === 0) delete updated.deviceAuthorities;
    this.sessions.set(sessionId, updated);
    return true;
  }
}

export function canReceiveStreamingAudio(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.output?.includes("streamed_audio"));
}

export function canUseApprovals(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.control?.includes("approvals"));
}

export function canSendTouchInteractions(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.control?.includes("touch"));
}

export function canReceiveArtifacts(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.output?.includes("artifact"));
}

export function canReceiveToolActivity(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.output?.includes("tool_activity"));
}

export function deriveChannelId(channelType: string, sessionId: string): string {
  const normalizedType = normalizeRequired(channelType, "channelType");
  const normalizedSession = normalizeRequired(sessionId, "sessionId");
  return `${normalizedType}:${normalizedSession}`;
}

export function normalizeCapabilities(capabilities?: SatelliteCapabilities): Required<SatelliteCapabilities> {
  return {
    input: uniqueOrDefault(capabilities?.input, DEFAULT_REALTIME_CAPABILITIES.input),
    output: uniqueOrDefault(capabilities?.output, DEFAULT_REALTIME_CAPABILITIES.output),
    control: uniqueOrDefault(capabilities?.control, DEFAULT_REALTIME_CAPABILITIES.control),
    safety: uniqueOrDefault(capabilities?.safety, DEFAULT_REALTIME_CAPABILITIES.safety),
  };
}

function contextFromSession(session: EmbodiedSession, sourceSatellite: AttachedSatellite): PsfnChannelContext {
  return {
    sessionId: session.sessionId,
    channelType: session.channelType,
    channelId: session.channelId,
    sourceSatelliteId: sourceSatellite.id,
    sourceSatelliteName: sourceSatellite.name,
    ...(session.claimIdentities?.[sourceSatellite.id]
      ? { claimIdentity: session.claimIdentities[sourceSatellite.id] }
      : {}),
    ...(session.deviceAuthorities?.[sourceSatellite.id]
      ? { deviceAuthority: session.deviceAuthorities[sourceSatellite.id] }
      : {}),
    activeSatellites: session.satellites.map((satellite) => ({
      id: satellite.id,
      name: satellite.name,
      transport: satellite.transport,
      capabilities: satellite.capabilities,
    })),
  };
}

function uniqueOrDefault<T extends string>(values: readonly T[] | undefined, fallback: readonly T[]): T[] {
  const source = values ?? fallback;
  return [...new Set(source.map((value) => value.trim()).filter(Boolean) as T[])];
}

function normalizeRequired(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
