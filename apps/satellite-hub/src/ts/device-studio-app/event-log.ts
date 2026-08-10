import type { BehaviorEvent } from "../device-studio/behavior.js";
import type {
  DeviceStudioConnectionState,
  DeviceStudioEventDirection,
  DeviceStudioEventSource,
  DeviceStudioTransportLogEntry,
  DeviceStudioTransportMode,
} from "../device-studio/transport.js";

export type DeviceStudioAppEventSource =
  | DeviceStudioEventSource
  | "behavior"
  | "import/export"
  | "hardware verification"
  | "sprite"
  | "user editing";

export interface DeviceStudioAppEventLogEntry {
  id: number;
  at: string;
  source: DeviceStudioAppEventSource;
  kind: string;
  mode?: DeviceStudioTransportMode;
  state?: DeviceStudioConnectionState;
  direction?: DeviceStudioEventDirection;
  profileId?: string;
  sessionId?: string;
  channelId?: string;
  messageType?: string;
  summary?: string;
  payload?: unknown;
  error?: string;
}

export interface DeviceStudioAppEventInput {
  at?: Date | string;
  source: DeviceStudioAppEventSource;
  kind: string;
  mode?: DeviceStudioTransportMode;
  state?: DeviceStudioConnectionState;
  direction?: DeviceStudioEventDirection;
  profileId?: string;
  sessionId?: string;
  channelId?: string;
  messageType?: string;
  summary?: string;
  payload?: unknown;
  error?: string;
}

export interface DeviceStudioEventContext {
  mode?: DeviceStudioTransportMode;
  profileId?: string;
  sessionId?: string;
  channelId?: string;
}

export interface DeviceStudioAppEventLogOptions {
  clock?: () => Date;
}

export interface DeviceStudioEventLogJsonEnvelope {
  schemaVersion: 1;
  exportedAt: string;
  count: number;
  entries: readonly DeviceStudioAppEventLogEntry[];
}

export interface DeviceStudioEventLogJsonOptions {
  exportedAt?: Date | string;
  space?: number;
}

export class DeviceStudioAppEventLog {
  private readonly clock: () => Date;
  private readonly records: DeviceStudioAppEventLogEntry[] = [];
  private sequence = 0;

  constructor(options: DeviceStudioAppEventLogOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  get entries(): readonly DeviceStudioAppEventLogEntry[] {
    return this.records;
  }

  append(input: DeviceStudioAppEventInput): DeviceStudioAppEventLogEntry {
    const entry = compactEntry({
      id: ++this.sequence,
      at: normalizeTimestamp(input.at ?? this.clock()),
      source: input.source,
      kind: input.kind,
      mode: input.mode,
      state: input.state,
      direction: input.direction,
      profileId: input.profileId,
      sessionId: input.sessionId,
      channelId: input.channelId,
      messageType: input.messageType,
      summary: input.summary,
      payload: input.payload,
      error: input.error,
    });
    this.records.push(entry);
    return entry;
  }

  appendTransportLog(
    entry: DeviceStudioTransportLogEntry,
    context: DeviceStudioEventContext = {},
  ): DeviceStudioAppEventLogEntry {
    return this.append({
      at: entry.at,
      source: entry.source,
      kind: entry.kind,
      mode: context.mode,
      state: entry.state,
      direction: entry.direction,
      profileId: entry.profileId ?? context.profileId,
      sessionId: entry.sessionId ?? context.sessionId,
      channelId: entry.channelId ?? context.channelId,
      messageType: entry.messageType,
      summary: entry.error,
      payload: entry.payload,
      error: entry.error,
    });
  }

  appendBehaviorEvent(
    event: BehaviorEvent,
    context: DeviceStudioEventContext = {},
  ): DeviceStudioAppEventLogEntry {
    return this.append({
      at: new Date(event.emittedAtMs),
      source: event.type === "behavior.import" || event.type === "behavior.export"
        ? "import/export"
        : "behavior",
      kind: event.type,
      mode: context.mode,
      profileId: "profileId" in event && event.profileId ? event.profileId : context.profileId,
      sessionId: context.sessionId,
      channelId: context.channelId,
      summary: summarizeBehaviorEvent(event),
      payload: event,
    });
  }

  toJson(options: DeviceStudioEventLogJsonOptions = {}): string {
    return exportDeviceStudioEventLog(this.records, options);
  }
}

export function exportDeviceStudioEventLog(
  entries: readonly DeviceStudioAppEventLogEntry[],
  options: DeviceStudioEventLogJsonOptions = {},
): string {
  const envelope: DeviceStudioEventLogJsonEnvelope = {
    schemaVersion: 1,
    exportedAt: normalizeTimestamp(options.exportedAt ?? new Date()),
    count: entries.length,
    entries: [...entries],
  };
  return JSON.stringify(envelope, null, options.space ?? 2);
}

export function formatDeviceStudioEventForClipboard(
  entries: readonly DeviceStudioAppEventLogEntry[],
): string {
  return exportDeviceStudioEventLog(entries, { space: 2 });
}

function normalizeTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid event timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function compactEntry(entry: DeviceStudioAppEventLogEntry): DeviceStudioAppEventLogEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as DeviceStudioAppEventLogEntry;
}

function summarizeBehaviorEvent(event: BehaviorEvent): string {
  switch (event.type) {
    case "behavior.import":
      return `${event.count} imported`;
    case "behavior.export":
      return `${event.count} exported / ${event.bytes} bytes`;
    case "behavior.playback.start":
      return `${event.behavior.name} started`;
    case "behavior.playback.stop":
      return `${event.behavior.name} stopped: ${event.reason}`;
    case "behavior.frame.apply":
      return `${event.behavior.name} frame ${event.frame.index + 1} @ ${event.frame.atMs}ms`;
  }
}
