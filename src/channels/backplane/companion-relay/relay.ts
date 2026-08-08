import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { EventBus } from '../../../shared/event-bus.js';
import type {
  CompanionArtifactCreatedPayload,
  CompanionArtifactPreviewSource,
  CompanionApprovalRequestedPayload,
  CompanionApprovalResolvedPayload,
  CompanionEmotionAcacAxisScore,
  CompanionEmotionDiscreteScore,
  CompanionEmotionSnapshotPayload,
  CompanionEmotionSnapshotTrigger,
  CompanionEventEnvelope,
  CompanionEventKind,
  CompanionToolActivityPayload,
} from '../../../shared/contracts/companion-relay.js';
import {
  isToolCallOutcome,
  type ToolCallOutcome,
} from '../../../shared/contracts/tool-call-outcome.js';
import {
  COMPANION_EMOTION_SNAPSHOT_TRIGGERS,
  COMPANION_TOOL_ACTIVITY_PHASES,
  type CompanionToolActivityPhase,
} from '../../../shared/contracts/companion-relay.js';
import { ACAC_AXES, type AcacAxis } from '../../../shared/contracts/emotion-contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { materializeContainedFileSync } from '../../../shared/utils/contained-file.js';
import type { ConfirmationApprovalOwner } from '../../../system/capabilities/confirmation-queue.js';

const log = createComponentLogger('CompanionEventRelay');

export const DEFAULT_MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_REGISTRY_ENTRIES = 500;
const MAX_SUBSCRIBERS = 32;

export interface CompanionEventSubscriber {
  /** Authenticated companion whose events this subscriber may receive. */
  companionId: string;
  /** Event kinds this subscriber is scoped to receive. Deny by default. */
  allowedKinds: readonly CompanionEventKind[];
  onEvent(envelope: CompanionEventEnvelope): void;
}

export interface CompanionArtifactPreviewEntry {
  artifactId: string;
  /** Authenticated producing companion; required for fleet-scoped reads. */
  companionId?: string;
  mediaType: string;
  sizeBytes: number;
  previewable: boolean;
  /** Immutable gateway-owned snapshot; null when above the preview cap. */
  bytes: Buffer | null;
}

export interface CompanionEventRelayOptions {
  eventBus: EventBus;
  /**
   * Canonical current/historical approval binding lookup. Approval events fail
   * closed when their queued parent/shard lineage cannot be verified.
   */
  approvalBindingOf?: (approvalId: string) => ConfirmationApprovalOwner | undefined;
  /** Owner used only by the single-companion runtime when an event omits it. */
  defaultCompanionId?: string;
  /**
   * Absolute directories artifact previews may be served from. Registration
   * of a preview source outside every root is rejected (fail closed). An
   * empty list disables previews entirely.
   */
  previewRoots?: readonly string[];
  /** Authenticated companion id -> its Personal Workspace image root. */
  previewRootByCompanionId?: Readonly<Record<string, string>>;
  maxPreviewBytes?: number;
}

/**
 * Gateway-side fan-out hub for redacted companion events (w9hj.1).
 *
 * Subscribes to the typed `companion.*` events on the gateway event bus,
 * wraps them into hub protocol envelopes, and delivers them to scope-gated
 * SSE subscribers. Also owns the artifact preview registry: preview source
 * paths arrive as an internal sidecar on `companion.artifact.created` and
 * never enter an outbound envelope.
 */
export class CompanionEventRelay {
  private readonly subscribers = new Set<CompanionEventSubscriber>();
  private readonly previews = new Map<string, CompanionArtifactPreviewEntry>();
  private readonly previewRoots: readonly string[];
  private readonly previewRootByCompanionId: Readonly<Record<string, string>> | null;
  private readonly maxPreviewBytes: number;
  private readonly defaultCompanionId: string | undefined;
  private readonly approvalBindingOf:
    ((approvalId: string) => ConfirmationApprovalOwner | undefined) | undefined;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: CompanionEventRelayOptions) {
    if (options.previewRoots && options.previewRootByCompanionId) {
      throw new Error('CompanionEventRelay preview roots must be single-companion or identity-bound, not both');
    }
    this.previewRoots = (options.previewRoots ?? []).map((root) => realpathSync(resolvePath(root)));
    this.previewRootByCompanionId = options.previewRootByCompanionId
      ? Object.fromEntries(Object.entries(options.previewRootByCompanionId).map(([id, root]) => [
        id,
        realpathSync(resolvePath(root)),
      ]))
      : null;
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_ARTIFACT_PREVIEW_BYTES;
    this.defaultCompanionId = options.defaultCompanionId;
    this.approvalBindingOf = options.approvalBindingOf;

    this.unsubscribes.push(
      options.eventBus.on('companion.approval.requested', ({ payload, companionId, shardId }) => {
        this.publish(companionId, {
          kind: 'approval.requested',
          payload,
          companionId,
          ...(shardId !== undefined ? { shardId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
      options.eventBus.on('companion.approval.resolved', ({ payload, companionId, shardId }) => {
        this.publish(companionId, {
          kind: 'approval.resolved',
          payload,
          companionId,
          ...(shardId !== undefined ? { shardId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
      options.eventBus.on('companion.artifact.created', ({ payload, preview, channelId, companionId }) => {
        const owner = companionId ?? this.defaultCompanionId;
        this.registerPreview(payload, preview, owner);
        this.publish(owner, {
          kind: 'artifact.created',
          payload,
          ...(owner ? { companionId: owner } : {}),
          ...(channelId ? { channelId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
      options.eventBus.on('companion.tool.activity', ({ payload, channelId, companionId }) => {
        this.publish(companionId ?? this.defaultCompanionId, {
          kind: 'tool.activity',
          payload,
          ...(companionId ?? this.defaultCompanionId
            ? { companionId: companionId ?? this.defaultCompanionId }
            : {}),
          ...(channelId ? { channelId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
      options.eventBus.on('companion.emotion.snapshot', ({ payload, channelId, companionId }) => {
        const owner = companionId ?? this.defaultCompanionId;
        this.publish(owner, {
          kind: 'emotion.snapshot',
          payload,
          ...(owner ? { companionId: owner } : {}),
          ...(channelId ? { channelId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.subscribers.clear();
    this.previews.clear();
  }

  subscribe(subscriber: CompanionEventSubscriber): () => void {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      throw new Error('Companion event relay subscriber limit reached');
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  getPreviewSource(artifactId: string, companionId?: string): CompanionArtifactPreviewEntry | null {
    const preview = this.previews.get(artifactId);
    if (!preview || (companionId !== undefined && preview.companionId !== companionId)) return null;
    return preview;
  }

  private publish(companionId: string | undefined, envelope: CompanionEventEnvelope): void {
    if (!companionId) {
      log.error('Refusing to publish ownerless companion event', { kind: envelope.kind });
      return;
    }
    if (envelope.companionId !== companionId
      || !this.approvalRoutingMetadataMatches(envelope)) {
      log.error('Refusing to publish companion event with mismatched routing metadata', {
        kind: envelope.kind,
      });
      return;
    }
    for (const subscriber of [...this.subscribers]) {
      if (subscriber.companionId !== companionId) continue;
      if (!subscriber.allowedKinds.includes(envelope.kind)) continue;
      try {
        subscriber.onEvent(envelope);
      } catch (error) {
        log.error('Companion event subscriber failed; dropping subscriber', {
          kind: envelope.kind,
          error: toErrorMessage(error),
        });
        this.subscribers.delete(subscriber);
      }
    }
  }

  private approvalRoutingMetadataMatches(envelope: CompanionEventEnvelope): boolean {
    if (envelope.kind === 'approval.requested') {
      const payload = envelope.payload as CompanionApprovalRequestedPayload;
      const binding = this.approvalBindingOf?.(payload.id);
      if (!binding
        || binding.companionId !== envelope.companionId
        || binding.shardId !== envelope.shardId) {
        return false;
      }
      if (!payload.attribution) return envelope.shardId === undefined;
      return payload.attribution.parentId === envelope.companionId
        && payload.attribution.shardId === envelope.shardId;
    }
    if (envelope.kind === 'approval.resolved') {
      const payload = envelope.payload as CompanionApprovalResolvedPayload;
      const binding = this.approvalBindingOf?.(payload.id);
      return binding !== undefined
        && binding.companionId === envelope.companionId
        && binding.shardId === envelope.shardId
        && payload.shardId === envelope.shardId;
    }
    return envelope.shardId === undefined;
  }

  private registerPreview(
    payload: CompanionArtifactCreatedPayload,
    preview: CompanionArtifactPreviewSource | undefined,
    companionId: string | undefined,
  ): void {
    if (!preview) return;
    if (preview.artifactId !== payload.id) {
      log.warn('Rejected artifact preview registration: id mismatch', {
        artifactId: payload.id,
      });
      return;
    }
    if (!payload.previewable) {
      log.warn('Rejected artifact preview registration: payload not previewable', {
        artifactId: payload.id,
      });
      return;
    }
    if (!Number.isFinite(preview.sizeBytes) || preview.sizeBytes <= 0) {
      log.warn('Rejected artifact preview registration: invalid size', {
        artifactId: payload.id,
      });
      return;
    }
    const allowedRoots = this.previewRootByCompanionId
      ? (companionId && this.previewRootByCompanionId[companionId]
        ? [this.previewRootByCompanionId[companionId]]
        : [])
      : this.previewRoots;
    let materialized: ReturnType<typeof materializeContainedFileSync> | null = null;
    for (const root of allowedRoots) {
      try {
        materialized = materializeContainedFileSync({
          path: preview.localPath,
          root,
          readMaxBytes: this.maxPreviewBytes,
        });
        break;
      } catch {
        // Try the next configured single-companion preview root. Multi-
        // companion registration has exactly one identity-bound root.
      }
    }
    if (!materialized) {
      log.warn('Rejected artifact preview registration: path outside authenticated companion preview root', {
        artifactId: payload.id,
        ...(companionId ? { companionId } : {}),
      });
      return;
    }
    if (materialized.sizeBytes !== preview.sizeBytes) {
      log.warn('Rejected artifact preview registration: declared size does not match opened file', {
        artifactId: payload.id,
        declaredSizeBytes: preview.sizeBytes,
        actualSizeBytes: materialized.sizeBytes,
      });
      return;
    }
    if (this.previews.size >= MAX_PREVIEW_REGISTRY_ENTRIES) {
      const oldest = this.previews.keys().next().value;
      if (oldest !== undefined) {
        this.previews.delete(oldest);
      }
    }
    this.previews.set(payload.id, {
      artifactId: payload.id,
      ...(companionId ? { companionId } : {}),
      mediaType: preview.mediaType,
      sizeBytes: materialized.sizeBytes,
      previewable: materialized.bytes !== null,
      bytes: materialized.bytes,
    });
  }

  maxPreviewSizeBytes(): number {
    return this.maxPreviewBytes;
  }
}

// ── Agent → gateway RPC boundary validation ──

export type CompanionRelayPublishParams =
  | {
    kind: 'tool.activity';
    payload: CompanionToolActivityPayload;
    channelId?: string;
  }
  | {
    kind: 'artifact.created';
    payload: CompanionArtifactCreatedPayload;
    channelId?: string;
    preview?: CompanionArtifactPreviewSource;
  }
  | {
    kind: 'emotion.snapshot';
    payload: CompanionEmotionSnapshotPayload;
    channelId?: string;
  };

function requireString(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`companion.event.publish: ${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`companion.event.publish: ${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  if (record[field] === undefined) return undefined;
  return requireString(record, field, maxLength);
}

function requireIsoTimestamp(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field, 64);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`companion.event.publish: ${field} must be an ISO timestamp`);
  }
  return value;
}

function requireBoundedNumber(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`companion.event.publish: ${field} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`companion.event.publish: ${field} must be in range [${min}, ${max}]`);
  }
  return value;
}

function parseEmotionVector(value: unknown, field: string): CompanionEmotionSnapshotPayload['vad'] {
  if (!isRecord(value)) {
    throw new Error(`companion.event.publish: ${field} must be an object`);
  }
  return {
    valence: requireBoundedNumber(value, 'valence', -1, 1),
    arousal: requireBoundedNumber(value, 'arousal', -1, 1),
    dominance: requireBoundedNumber(value, 'dominance', -1, 1),
  };
}

function parseEmotionDiscreteScores(value: unknown): CompanionEmotionDiscreteScore[] {
  if (!Array.isArray(value)) {
    throw new Error('companion.event.publish: emotion discrete must be an array');
  }
  if (value.length > 16) {
    throw new Error('companion.event.publish: emotion discrete has too many entries');
  }
  return value.map((entry): CompanionEmotionDiscreteScore => {
    if (!isRecord(entry)) {
      throw new Error('companion.event.publish: emotion discrete entry must be an object');
    }
    return {
      label: requireString(entry, 'label', 48),
      score: requireBoundedNumber(entry, 'score', 0, 1),
    };
  });
}

function parseEmotionAcacAxes(value: unknown): CompanionEmotionAcacAxisScore[] {
  if (!Array.isArray(value)) {
    throw new Error('companion.event.publish: emotion acacAxes must be an array');
  }
  if (value.length > ACAC_AXES.length) {
    throw new Error('companion.event.publish: emotion acacAxes has too many entries');
  }
  const seen = new Set<AcacAxis>();
  return value.map((entry): CompanionEmotionAcacAxisScore => {
    if (!isRecord(entry)) {
      throw new Error('companion.event.publish: emotion acacAxes entry must be an object');
    }
    const axis = requireString(entry, 'axis', 32);
    if (!ACAC_AXES.includes(axis as AcacAxis)) {
      throw new Error('companion.event.publish: emotion acacAxes contains an unknown axis');
    }
    if (seen.has(axis as AcacAxis)) {
      throw new Error('companion.event.publish: emotion acacAxes contains a duplicate axis');
    }
    seen.add(axis as AcacAxis);
    return { axis: axis as AcacAxis, score: requireBoundedNumber(entry, 'score', 0, 1) };
  });
}

/**
 * Fail-closed parse of agent-forwarded companion events at the gateway RPC
 * boundary. Payloads are RECONSTRUCTED field-by-field from a whitelist —
 * unknown fields are dropped even if a (compromised) agent sends them, so
 * the redaction contract holds at the process boundary, not just at the
 * agent-side emission site. Approval kinds are rejected outright: they
 * originate inside the gateway and must not be spoofable over RPC.
 */
export function parseCompanionRelayPublishParams(params: unknown): CompanionRelayPublishParams {
  if (!isRecord(params)) {
    throw new Error('companion.event.publish: params must be an object');
  }
  const kind = params.kind;
  if (kind !== 'artifact.created' && kind !== 'tool.activity' && kind !== 'emotion.snapshot') {
    throw new Error(
      'companion.event.publish: kind must be artifact.created, tool.activity, or emotion.snapshot',
    );
  }
  if (!isRecord(params.payload)) {
    throw new Error('companion.event.publish: payload must be an object');
  }
  const channelId = optionalString(params, 'channelId', 256);
  const payload = params.payload;

  if (kind === 'emotion.snapshot') {
    const trigger = requireString(payload, 'trigger', 32);
    if (!COMPANION_EMOTION_SNAPSHOT_TRIGGERS.includes(trigger as CompanionEmotionSnapshotTrigger)) {
      throw new Error('companion.event.publish: invalid emotion snapshot trigger');
    }
    const acacAxes = payload.acacAxes === undefined
      ? undefined
      : parseEmotionAcacAxes(payload.acacAxes);
    const parsed: CompanionEmotionSnapshotPayload = {
      trigger: trigger as CompanionEmotionSnapshotTrigger,
      vad: parseEmotionVector(payload.vad, 'emotion vad'),
      mood: parseEmotionVector(payload.mood, 'emotion mood'),
      discrete: parseEmotionDiscreteScores(payload.discrete),
      confidence: requireBoundedNumber(payload, 'confidence', 0, 1),
      ...(acacAxes && acacAxes.length > 0 ? { acacAxes } : {}),
      timestamp: requireIsoTimestamp(payload, 'timestamp'),
    };
    return { kind, payload: parsed, ...(channelId ? { channelId } : {}) };
  }

  if (kind === 'tool.activity') {
    const phase = requireString(payload, 'phase', 32);
    if (!COMPANION_TOOL_ACTIVITY_PHASES.includes(phase as CompanionToolActivityPhase)) {
      throw new Error('companion.event.publish: invalid tool activity phase');
    }
    const detail = optionalString(payload, 'detail', 200);
    const outcome = optionalString(payload, 'outcome', 32);
    if (outcome !== undefined && !isToolCallOutcome(outcome)) {
      throw new Error('companion.event.publish: invalid tool activity outcome');
    }
    const parsed: CompanionToolActivityPayload = {
      id: requireString(payload, 'id', 160),
      tool: requireString(payload, 'tool', 120),
      phase: phase as CompanionToolActivityPhase,
      ...(outcome !== undefined ? { outcome: outcome as ToolCallOutcome } : {}),
      ...(detail !== undefined ? { detail } : {}),
      timestamp: requireIsoTimestamp(payload, 'timestamp'),
    };
    return { kind, payload: parsed, ...(channelId ? { channelId } : {}) };
  }

  const artifactPayload: CompanionArtifactCreatedPayload = {
    id: requireString(payload, 'id', 160),
    label: requireString(payload, 'label', 120),
    mediaType: requireString(payload, 'mediaType', 100),
    provenance: requireString(payload, 'provenance', 120),
    createdAt: requireIsoTimestamp(payload, 'createdAt'),
    previewable: payload.previewable === true,
  };

  let preview: CompanionArtifactPreviewSource | undefined;
  if (params.preview !== undefined) {
    if (!isRecord(params.preview)) {
      throw new Error('companion.event.publish: preview must be an object');
    }
    const sizeBytes = params.preview.sizeBytes;
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error('companion.event.publish: preview.sizeBytes must be a positive number');
    }
    preview = {
      artifactId: requireString(params.preview, 'artifactId', 160),
      localPath: requireString(params.preview, 'localPath', 1024),
      mediaType: requireString(params.preview, 'mediaType', 100),
      sizeBytes,
    };
  }

  return {
    kind,
    payload: artifactPayload,
    ...(channelId ? { channelId } : {}),
    ...(preview ? { preview } : {}),
  };
}

export function newCompanionArtifactId(): string {
  return `art-${randomUUID()}`;
}
