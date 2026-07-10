import type { SatelliteCapabilities } from "../shared/protocol.js";

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
  transport: "websocket";
  capabilities: Required<SatelliteCapabilities>;
  attachedAt: string;
  updatedAt: string;
}

export interface EmbodiedSession {
  sessionId: string;
  channelType: string;
  channelId: string;
  satellites: AttachedSatellite[];
  createdAt: string;
  updatedAt: string;
}

export interface PsfnChannelContext {
  sessionId: string;
  channelType: string;
  channelId: string;
  sourceSatelliteId: string;
  sourceSatelliteName: string;
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
  capabilities?: SatelliteCapabilities;
}

export class EmbodiedSessionRegistry {
  private readonly sessions = new Map<string, EmbodiedSession>();

  constructor(private readonly channelType: string = DEFAULT_PSFN_CHANNEL_TYPE) {}

  attachSatellite(input: AttachSatelliteInput): { session: EmbodiedSession; satellite: AttachedSatellite } {
    const sessionId = normalizeRequired(input.sessionId, "sessionId");
    const satelliteId = normalizeRequired(input.satelliteId, "satelliteId");
    const now = new Date().toISOString();
    const current = this.sessions.get(sessionId);
    const channelId = normalizeOptional(input.channelId) ?? current?.channelId ?? deriveChannelId(this.channelType, sessionId);
    const satellite: AttachedSatellite = {
      id: satelliteId,
      name: normalizeOptional(input.satelliteName) ?? satelliteId,
      transport: "websocket",
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
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    return { session, satellite };
  }

  getContext(sessionId: string, sourceSatelliteId: string): PsfnChannelContext {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const { session: created, satellite } = this.attachSatellite({
        sessionId,
        satelliteId: sourceSatelliteId,
        satelliteName: sourceSatelliteId,
      });
      return contextFromSession(created, satellite);
    }
    const source = session.satellites.find((satellite) => satellite.id === sourceSatelliteId) ?? session.satellites[0];
    if (!source) {
      const { session: updated, satellite } = this.attachSatellite({
        sessionId,
        satelliteId: sourceSatelliteId,
        satelliteName: sourceSatelliteId,
      });
      return contextFromSession(updated, satellite);
    }
    return contextFromSession(session, source);
  }

  getSession(sessionId: string): EmbodiedSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}

export function canReceiveStreamingAudio(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.output?.includes("streamed_audio"));
}

export function canUseApprovals(capabilities: SatelliteCapabilities): boolean {
  return Boolean(capabilities.control?.includes("approvals"));
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
    activeSatellites: session.satellites.map((satellite) => ({
      id: satellite.id,
      name: satellite.name,
      transport: satellite.transport,
      capabilities: satellite.capabilities,
    })),
  };
}

function uniqueOrDefault<T extends string>(values: readonly T[] | undefined, fallback: readonly T[]): T[] {
  const source = values && values.length > 0 ? values : fallback;
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
