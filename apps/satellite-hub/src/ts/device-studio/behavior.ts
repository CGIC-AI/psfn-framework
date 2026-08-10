import { behaviorFixtures } from "./fixtures.js";
import {
  applyBehaviorToProfile,
  assertValidBehaviorTimeline,
  calculateBehaviorDuration,
  inferBehaviorChannels,
  isGeneratedProvenance,
  isHardwareVerified,
} from "./model.js";
import type {
  BacklightFrameState,
  BehaviorChannel,
  BehaviorFrame,
  BehaviorTimeline,
  DeviceProfile,
  DisplayFrameState,
  ExpressionState,
  HardwareVerificationStatus,
  IgnoredBehaviorChannel,
  JointFrameState,
  LedFrameState,
  ProvenanceSource,
  VisemeState,
} from "./model.js";

const EVENT_SOURCE = "device-studio.behavior";

export type BehaviorEventType =
  | "behavior.import"
  | "behavior.export"
  | "behavior.playback.start"
  | "behavior.playback.stop"
  | "behavior.frame.apply";

export type BehaviorEventSink = (event: BehaviorEvent) => void;

export interface BehaviorEventOptions {
  emit?: BehaviorEventSink;
  now?: () => number;
}

export interface BehaviorEventBehaviorReference {
  id: string;
  name: string;
  sourceLabel: string;
  provenanceSource: ProvenanceSource;
  generated: boolean;
  hardwareVerificationStatus: HardwareVerificationStatus;
  hardwareVerified: boolean;
}

export interface BehaviorEventBase {
  schemaVersion: 1;
  type: BehaviorEventType;
  source: typeof EVENT_SOURCE;
  emittedAtMs: number;
}

export interface BehaviorImportEvent extends BehaviorEventBase {
  type: "behavior.import";
  count: number;
  behaviorIds: string[];
  behaviors: BehaviorEventBehaviorReference[];
}

export interface BehaviorExportEvent extends BehaviorEventBase {
  type: "behavior.export";
  count: number;
  behaviorIds: string[];
  behaviors: BehaviorEventBehaviorReference[];
  bytes: number;
}

export interface BehaviorPlaybackStartEvent extends BehaviorEventBase {
  type: "behavior.playback.start";
  behavior: BehaviorEventBehaviorReference;
  profileId?: string;
  durationMs: number;
  channels: BehaviorChannel[];
  supportedChannels: BehaviorChannel[];
  ignoredChannels: IgnoredBehaviorChannel[];
  compatible: boolean;
  renderState: NormalizedBehaviorRenderState;
}

export interface BehaviorPlaybackStopEvent extends BehaviorEventBase {
  type: "behavior.playback.stop";
  behavior: BehaviorEventBehaviorReference;
  profileId?: string;
  reason: string;
  elapsedMs: number;
  renderState: NormalizedBehaviorRenderState;
}

export interface BehaviorFrameApplyEvent extends BehaviorEventBase {
  type: "behavior.frame.apply";
  behavior: BehaviorEventBehaviorReference;
  profileId?: string;
  elapsedMs: number;
  frame: BehaviorFrameReference;
  renderState: NormalizedBehaviorRenderState;
}

export type BehaviorEvent =
  | BehaviorImportEvent
  | BehaviorExportEvent
  | BehaviorPlaybackStartEvent
  | BehaviorPlaybackStopEvent
  | BehaviorFrameApplyEvent;

type BehaviorEventEnvelopeField = "schemaVersion" | "source" | "emittedAtMs";

type BehaviorEventPayload =
  | Omit<BehaviorImportEvent, BehaviorEventEnvelopeField>
  | Omit<BehaviorExportEvent, BehaviorEventEnvelopeField>
  | Omit<BehaviorPlaybackStartEvent, BehaviorEventEnvelopeField>
  | Omit<BehaviorPlaybackStopEvent, BehaviorEventEnvelopeField>
  | Omit<BehaviorFrameApplyEvent, BehaviorEventEnvelopeField>;

export interface BehaviorFrameReference {
  index: number;
  atMs: number;
  durationMs?: number;
  label?: string;
}

export interface NormalizedBehaviorRenderState {
  behaviorId: string;
  behaviorName: string;
  profileId?: string;
  requestedElapsedMs: number;
  elapsedMs: number;
  durationMs: number;
  progress: number;
  complete: boolean;
  sourceLabel: string;
  provenanceSource: ProvenanceSource;
  generated: boolean;
  hardwareVerificationStatus: HardwareVerificationStatus;
  hardwareVerified: boolean;
  compatible: boolean;
  channels: BehaviorChannel[];
  supportedChannels: BehaviorChannel[];
  ignoredChannels: IgnoredBehaviorChannel[];
  activeFrame?: BehaviorFrameReference;
  nextFrame?: BehaviorFrameReference;
  expression?: ExpressionState;
  viseme?: VisemeState;
  joints: Record<string, JointFrameState>;
  display?: DisplayFrameState;
  backlight?: BacklightFrameState;
  leds: Record<string, LedFrameState>;
}

export interface BehaviorLibraryFilter {
  profile?: DeviceProfile | string;
  includeIncompatible?: boolean;
  channel?: BehaviorChannel;
  channels?: BehaviorChannel[];
  anyChannel?: BehaviorChannel[];
  provenanceSource?: ProvenanceSource | ProvenanceSource[];
  generated?: boolean;
  hardwareVerified?: boolean;
  hardwareVerificationStatus?: HardwareVerificationStatus | HardwareVerificationStatus[];
}

export interface BehaviorLibraryEntry {
  id: string;
  name: string;
  durationMs: number;
  channels: BehaviorChannel[];
  sourceLabel: string;
  provenanceSource: ProvenanceSource;
  generated: boolean;
  hardwareVerificationStatus: HardwareVerificationStatus;
  hardwareVerified: boolean;
  compatible: boolean;
  supportedChannels: BehaviorChannel[];
  ignoredChannels: IgnoredBehaviorChannel[];
  timeline: BehaviorTimeline;
}

export interface BehaviorJsonOptions extends BehaviorEventOptions {
  space?: number;
}

export interface BehaviorSamplingOptions {
  profile?: DeviceProfile;
}

export interface BehaviorPlaybackOptions extends BehaviorSamplingOptions, BehaviorEventOptions {
  timeline: BehaviorTimeline;
}

export class BehaviorLibrary {
  private readonly timelinesById: Map<string, BehaviorTimeline>;

  constructor(definitions: Iterable<BehaviorTimeline> = behaviorFixtures) {
    this.timelinesById = new Map(
      loadBehaviorDefinitions(definitions).map((timeline) => [timeline.id, timeline] as const),
    );
  }

  get size(): number {
    return this.timelinesById.size;
  }

  get(id: string): BehaviorTimeline | undefined {
    const timeline = this.timelinesById.get(id);
    return timeline ? cloneJsonish(timeline) : undefined;
  }

  require(id: string): BehaviorTimeline {
    const timeline = this.get(id);
    if (!timeline) {
      throw new Error(`Unknown behavior ${id}`);
    }
    return timeline;
  }

  list(filter: BehaviorLibraryFilter = {}): BehaviorLibraryEntry[] {
    const entries: BehaviorLibraryEntry[] = [];
    for (const timeline of this.timelinesById.values()) {
      const entry = createBehaviorLibraryEntry(timeline, filter);
      if (matchesBehaviorLibraryFilter(entry, filter)) {
        entries.push(entry);
      }
    }
    return entries;
  }

  exportJson(options: BehaviorJsonOptions = {}): string {
    return exportBehaviorLibrary(this, options);
  }
}

export class BehaviorPlayback {
  private readonly timeline: BehaviorTimeline;
  private readonly profile: DeviceProfile | undefined;
  private readonly emit: BehaviorEventSink | undefined;
  private readonly now: () => number;
  private playing = false;
  private lastElapsedMs = 0;
  private lastAppliedFrameKey: string | undefined;

  constructor(options: BehaviorPlaybackOptions) {
    this.timeline = normalizeBehaviorTimeline(options.timeline);
    this.profile = options.profile ? cloneJsonish(options.profile) : undefined;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
  }

  start(elapsedMs = 0): NormalizedBehaviorRenderState {
    this.playing = true;
    this.lastAppliedFrameKey = undefined;
    const state = this.render(elapsedMs);
    this.lastElapsedMs = state.elapsedMs;
    this.emitEvent({
      type: "behavior.playback.start",
      behavior: createBehaviorReference(this.timeline),
      profileId: state.profileId,
      durationMs: state.durationMs,
      channels: state.channels,
      supportedChannels: state.supportedChannels,
      ignoredChannels: state.ignoredChannels,
      compatible: state.compatible,
      renderState: state,
    });
    return state;
  }

  sample(elapsedMs: number): NormalizedBehaviorRenderState {
    const state = this.render(elapsedMs);
    this.lastElapsedMs = state.elapsedMs;
    if (this.playing && state.activeFrame) {
      const frameKey = `${state.activeFrame.index}:${state.activeFrame.atMs}`;
      if (frameKey !== this.lastAppliedFrameKey) {
        this.lastAppliedFrameKey = frameKey;
        this.emitEvent({
          type: "behavior.frame.apply",
          behavior: createBehaviorReference(this.timeline),
          profileId: state.profileId,
          elapsedMs: state.elapsedMs,
          frame: state.activeFrame,
          renderState: state,
        });
      }
    }
    return state;
  }

  stop(reason = "stopped", elapsedMs = this.lastElapsedMs): NormalizedBehaviorRenderState {
    const state = this.render(elapsedMs);
    this.lastElapsedMs = state.elapsedMs;
    this.playing = false;
    this.emitEvent({
      type: "behavior.playback.stop",
      behavior: createBehaviorReference(this.timeline),
      profileId: state.profileId,
      reason,
      elapsedMs: state.elapsedMs,
      renderState: state,
    });
    return state;
  }

  private render(elapsedMs: number): NormalizedBehaviorRenderState {
    return sampleBehaviorRenderState(this.timeline, elapsedMs, { profile: this.profile });
  }

  private emitEvent(event: BehaviorEventPayload): void {
    if (!this.emit) return;
    this.emit({
      schemaVersion: 1,
      source: EVENT_SOURCE,
      emittedAtMs: this.now(),
      ...event,
    } as BehaviorEvent);
  }
}

export function createBehaviorLibrary(
  definitions: Iterable<BehaviorTimeline> = behaviorFixtures,
): BehaviorLibrary {
  return new BehaviorLibrary(definitions);
}

export function createFixtureBehaviorLibrary(): BehaviorLibrary {
  return new BehaviorLibrary(behaviorFixtures);
}

export function createBehaviorPlayback(options: BehaviorPlaybackOptions): BehaviorPlayback {
  return new BehaviorPlayback(options);
}

export function loadBehaviorDefinitions(definitions: Iterable<BehaviorTimeline>): BehaviorTimeline[] {
  const timelines: BehaviorTimeline[] = [];
  const seenIds = new Set<string>();

  for (const definition of definitions) {
    const timeline = normalizeBehaviorTimeline(definition);
    if (seenIds.has(timeline.id)) {
      throw new Error(`Duplicate behavior id ${timeline.id}`);
    }
    seenIds.add(timeline.id);
    timelines.push(timeline);
  }

  return timelines.sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizeBehaviorTimeline(timeline: BehaviorTimeline): BehaviorTimeline {
  const normalized = cloneJsonish(timeline);

  if (Array.isArray(normalized.frames)) {
    normalized.frames = normalized.frames
      .map((frame, index) => ({ frame, index }))
      .sort((left, right) => {
        const byTime = left.frame.atMs - right.frame.atMs;
        return byTime === 0 ? left.index - right.index : byTime;
      })
      .map(({ frame }) => frame);
    normalized.channels = inferBehaviorChannels(normalized);
    normalized.durationMs = calculateBehaviorDuration(normalized);
  }

  assertValidBehaviorTimeline(normalized);
  return normalized;
}

export function listBehaviorDefinitions(
  definitions: Iterable<BehaviorTimeline>,
  filter: BehaviorLibraryFilter = {},
): BehaviorLibraryEntry[] {
  return new BehaviorLibrary(definitions).list(filter);
}

export function getBehaviorSourceLabel(timeline: BehaviorTimeline): string {
  return timeline.provenance.label;
}

export function isGeneratedBehavior(timeline: BehaviorTimeline): boolean {
  return isGeneratedProvenance(timeline.provenance);
}

export function isHardwareVerifiedBehavior(timeline: BehaviorTimeline): boolean {
  return isHardwareVerified(timeline.hardwareVerification);
}

export function importBehaviorTimeline(json: string, options: BehaviorEventOptions = {}): BehaviorTimeline {
  const parsed = parseBehaviorJson(json);
  const timelines = extractBehaviorValues(parsed);
  if (timelines.length !== 1) {
    throw new Error(`Expected exactly one behavior timeline, received ${timelines.length}`);
  }

  const first = timelines[0];
  if (!first) {
    throw new Error("Expected exactly one behavior timeline, received 0");
  }

  const timeline = normalizeBehaviorTimeline(first as BehaviorTimeline);
  emitImportEvent(options, [timeline]);
  return timeline;
}

export function importBehaviorLibraryJson(json: string, options: BehaviorEventOptions = {}): BehaviorLibrary {
  const parsed = parseBehaviorJson(json);
  const timelines = loadBehaviorDefinitions(extractBehaviorValues(parsed) as BehaviorTimeline[]);
  emitImportEvent(options, timelines);
  return new BehaviorLibrary(timelines);
}

export function exportBehaviorTimeline(timeline: BehaviorTimeline, options: BehaviorJsonOptions = {}): string {
  const normalized = normalizeBehaviorTimeline(timeline);
  const json = toDeterministicJson(normalized, options.space ?? 2);
  emitExportEvent(options, [normalized], json.length);
  return json;
}

export function exportBehaviorLibrary(
  libraryOrDefinitions: BehaviorLibrary | Iterable<BehaviorTimeline>,
  options: BehaviorJsonOptions = {},
): string {
  const timelines = libraryOrDefinitions instanceof BehaviorLibrary
    ? libraryOrDefinitions.list().map((entry) => entry.timeline)
    : loadBehaviorDefinitions(libraryOrDefinitions);
  const json = toDeterministicJson({ behaviors: timelines }, options.space ?? 2);
  emitExportEvent(options, timelines, json.length);
  return json;
}

export function sampleBehaviorRenderState(
  timeline: BehaviorTimeline,
  elapsedMs: number,
  options: BehaviorSamplingOptions = {},
): NormalizedBehaviorRenderState {
  const normalized = normalizeBehaviorTimeline(timeline);
  const application = options.profile ? applyBehaviorToProfile(options.profile, normalized) : undefined;
  const effectiveTimeline = application?.timeline ?? normalized;
  const durationMs = calculateBehaviorDuration(effectiveTimeline);
  const requestedElapsedMs = requireFiniteNumber(elapsedMs, "elapsedMs");
  const sampledElapsedMs = durationMs === 0
    ? 0
    : Math.min(Math.max(requestedElapsedMs, 0), durationMs);
  const active = findActiveFrame(effectiveTimeline.frames, sampledElapsedMs);
  const next = findNextFrame(effectiveTimeline.frames, sampledElapsedMs);
  const channels = inferBehaviorChannels(effectiveTimeline);
  const reference = createBehaviorReference(normalized);

  return {
    behaviorId: normalized.id,
    behaviorName: normalized.name,
    profileId: options.profile?.id,
    requestedElapsedMs,
    elapsedMs: sampledElapsedMs,
    durationMs,
    progress: durationMs === 0 ? 1 : sampledElapsedMs / durationMs,
    complete: durationMs === 0 ? requestedElapsedMs >= 0 : requestedElapsedMs >= durationMs,
    sourceLabel: reference.sourceLabel,
    provenanceSource: reference.provenanceSource,
    generated: reference.generated,
    hardwareVerificationStatus: reference.hardwareVerificationStatus,
    hardwareVerified: reference.hardwareVerified,
    compatible: application?.compatible ?? true,
    channels,
    supportedChannels: application?.supportedChannels ?? channels,
    ignoredChannels: application?.ignoredChannels ?? [],
    activeFrame: active ? frameReference(active.frame, active.index) : undefined,
    nextFrame: next ? frameReference(next.frame, next.index) : undefined,
    expression: latestFrameValue(effectiveTimeline.frames, sampledElapsedMs, (frame) => frame.expression),
    viseme: latestFrameValue(effectiveTimeline.frames, sampledElapsedMs, (frame) => frame.viseme),
    joints: sampleJointStates(effectiveTimeline.frames, sampledElapsedMs),
    display: latestFrameValue(effectiveTimeline.frames, sampledElapsedMs, (frame) => frame.display),
    backlight: latestFrameValue(effectiveTimeline.frames, sampledElapsedMs, (frame) => frame.backlight),
    leds: sampleLatestRecordStates(effectiveTimeline.frames, sampledElapsedMs, (frame) => frame.leds),
  };
}

function createBehaviorLibraryEntry(
  timeline: BehaviorTimeline,
  filter: BehaviorLibraryFilter,
): BehaviorLibraryEntry {
  const profile = typeof filter.profile === "object" ? filter.profile : undefined;
  const profileId = typeof filter.profile === "string" ? filter.profile : profile?.id;
  const application = profile ? applyBehaviorToProfile(profile, timeline) : undefined;
  const compatible = profileId
    ? timeline.compatibleProfileIds.length === 0 || timeline.compatibleProfileIds.includes(profileId)
    : true;
  const effectiveTimeline = application?.timeline ?? timeline;
  const channels = inferBehaviorChannels(effectiveTimeline);

  return {
    id: timeline.id,
    name: timeline.name,
    durationMs: calculateBehaviorDuration(timeline),
    channels,
    sourceLabel: getBehaviorSourceLabel(timeline),
    provenanceSource: timeline.provenance.source,
    generated: isGeneratedBehavior(timeline),
    hardwareVerificationStatus: timeline.hardwareVerification.status,
    hardwareVerified: isHardwareVerifiedBehavior(timeline),
    compatible: application?.compatible ?? compatible,
    supportedChannels: application?.supportedChannels ?? channels,
    ignoredChannels: application?.ignoredChannels ?? [],
    timeline: cloneJsonish(effectiveTimeline),
  };
}

function matchesBehaviorLibraryFilter(entry: BehaviorLibraryEntry, filter: BehaviorLibraryFilter): boolean {
  if (filter.profile && !filter.includeIncompatible && !entry.compatible) return false;
  if (filter.channel && !entry.channels.includes(filter.channel)) return false;
  if (filter.channels && !filter.channels.every((channel) => entry.channels.includes(channel))) return false;
  if (filter.anyChannel && !filter.anyChannel.some((channel) => entry.channels.includes(channel))) return false;
  if (filter.provenanceSource && !oneOf(filter.provenanceSource, entry.provenanceSource)) return false;
  if (filter.generated !== undefined && entry.generated !== filter.generated) return false;
  if (filter.hardwareVerified !== undefined && entry.hardwareVerified !== filter.hardwareVerified) return false;
  if (
    filter.hardwareVerificationStatus
    && !oneOf(filter.hardwareVerificationStatus, entry.hardwareVerificationStatus)
  ) {
    return false;
  }
  return true;
}

function oneOf<T extends string>(expected: T | T[], actual: T): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function emitImportEvent(options: BehaviorEventOptions, timelines: BehaviorTimeline[]): void {
  emitStructuredEvent(options, {
    type: "behavior.import",
    count: timelines.length,
    behaviorIds: timelines.map((timeline) => timeline.id),
    behaviors: timelines.map(createBehaviorReference),
  });
}

function emitExportEvent(options: BehaviorJsonOptions, timelines: BehaviorTimeline[], bytes: number): void {
  emitStructuredEvent(options, {
    type: "behavior.export",
    count: timelines.length,
    behaviorIds: timelines.map((timeline) => timeline.id),
    behaviors: timelines.map(createBehaviorReference),
    bytes,
  });
}

function emitStructuredEvent(
  options: BehaviorEventOptions,
  event: BehaviorEventPayload,
): void {
  if (!options.emit) return;
  options.emit({
    schemaVersion: 1,
    source: EVENT_SOURCE,
    emittedAtMs: options.now?.() ?? Date.now(),
    ...event,
  } as BehaviorEvent);
}

function createBehaviorReference(timeline: BehaviorTimeline): BehaviorEventBehaviorReference {
  return {
    id: timeline.id,
    name: timeline.name,
    sourceLabel: getBehaviorSourceLabel(timeline),
    provenanceSource: timeline.provenance.source,
    generated: isGeneratedBehavior(timeline),
    hardwareVerificationStatus: timeline.hardwareVerification.status,
    hardwareVerified: isHardwareVerifiedBehavior(timeline),
  };
}

function findActiveFrame(
  frames: BehaviorFrame[],
  elapsedMs: number,
): { frame: BehaviorFrame; index: number } | undefined {
  let active: { frame: BehaviorFrame; index: number } | undefined;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (frame.atMs > elapsedMs) break;
    active = { frame, index };
  }
  return active;
}

function findNextFrame(
  frames: BehaviorFrame[],
  elapsedMs: number,
): { frame: BehaviorFrame; index: number } | undefined {
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (frame.atMs > elapsedMs) {
      return { frame, index };
    }
  }
  return undefined;
}

function frameReference(frame: BehaviorFrame, index: number): BehaviorFrameReference {
  return {
    index,
    atMs: frame.atMs,
    durationMs: frame.durationMs,
    label: frame.label,
  };
}

function latestFrameValue<T>(
  frames: BehaviorFrame[],
  elapsedMs: number,
  read: (frame: BehaviorFrame) => T | undefined,
): T | undefined {
  let value: T | undefined;
  for (const frame of frames) {
    if (frame.atMs > elapsedMs) break;
    const next = read(frame);
    if (next !== undefined) {
      value = cloneJsonish(next);
    }
  }
  return value;
}

function sampleJointStates(frames: BehaviorFrame[], elapsedMs: number): Record<string, JointFrameState> {
  const jointIds = new Set<string>();
  for (const frame of frames) {
    for (const jointId of Object.keys(frame.joints ?? {})) {
      jointIds.add(jointId);
    }
  }

  const states: Record<string, JointFrameState> = {};
  for (const jointId of [...jointIds].sort()) {
    const value = interpolateJointValue(frames, jointId, elapsedMs);
    if (value !== undefined) {
      states[jointId] = { value };
    }
  }
  return states;
}

function interpolateJointValue(frames: BehaviorFrame[], jointId: string, elapsedMs: number): number | undefined {
  let previous: { atMs: number; value: number } | undefined;
  let next: { atMs: number; value: number } | undefined;

  for (const frame of frames) {
    const joint = frame.joints?.[jointId];
    if (!joint) continue;
    if (frame.atMs <= elapsedMs) {
      previous = { atMs: frame.atMs, value: joint.value };
      continue;
    }
    next = { atMs: frame.atMs, value: joint.value };
    break;
  }

  if (!previous) return undefined;
  if (!next || next.atMs === previous.atMs) return previous.value;

  const progress = (elapsedMs - previous.atMs) / (next.atMs - previous.atMs);
  return previous.value + (next.value - previous.value) * progress;
}

function sampleLatestRecordStates<T>(
  frames: BehaviorFrame[],
  elapsedMs: number,
  read: (frame: BehaviorFrame) => Record<string, T> | undefined,
): Record<string, T> {
  const states: Record<string, T> = {};
  for (const frame of frames) {
    if (frame.atMs > elapsedMs) break;
    const record = read(frame);
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      states[key] = cloneJsonish(value);
    }
  }
  return sortRecord(states);
}

function parseBehaviorJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid behavior JSON: ${message}`);
  }
}

function extractBehaviorValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.behaviors)) return record.behaviors;
  return [value];
}

function toDeterministicJson(value: unknown, space: number): string {
  return `${JSON.stringify(sortJsonValue(value), null, space)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child !== undefined) {
      sorted[key] = sortJsonValue(child);
    }
  }
  return sorted;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return sorted;
}

function requireFiniteNumber(value: number, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function cloneJsonish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
