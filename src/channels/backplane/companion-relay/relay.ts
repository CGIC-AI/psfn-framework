import { randomUUID } from 'node:crypto';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import type { EventBus } from '../../../shared/event-bus.js';
import type {
  CompanionArtifactCreatedPayload,
  CompanionArtifactPreviewSource,
  CompanionEventEnvelope,
  CompanionEventKind,
  CompanionToolActivityPayload,
} from '../../../shared/contracts/companion-relay.js';
import {
  COMPANION_TOOL_ACTIVITY_PHASES,
  type CompanionToolActivityPhase,
} from '../../../shared/contracts/companion-relay.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('CompanionEventRelay');

export const DEFAULT_MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_REGISTRY_ENTRIES = 500;
const MAX_SUBSCRIBERS = 32;

export interface CompanionEventSubscriber {
  /** Event kinds this subscriber is scoped to receive. Deny by default. */
  allowedKinds: readonly CompanionEventKind[];
  onEvent(envelope: CompanionEventEnvelope): void;
}

export interface CompanionArtifactPreviewEntry {
  artifactId: string;
  localPath: string;
  mediaType: string;
  sizeBytes: number;
  previewable: boolean;
}

export interface CompanionEventRelayOptions {
  eventBus: EventBus;
  /**
   * Absolute directories artifact previews may be served from. Registration
   * of a preview source outside every root is rejected (fail closed). An
   * empty list disables previews entirely.
   */
  previewRoots: readonly string[];
  maxPreviewBytes?: number;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = resolvePath(root);
  const resolvedCandidate = resolvePath(candidate);
  return resolvedCandidate === resolvedRoot
    || resolvedCandidate.startsWith(`${resolvedRoot}${pathSep}`);
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
  private readonly maxPreviewBytes: number;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: CompanionEventRelayOptions) {
    this.previewRoots = options.previewRoots.map((root) => resolvePath(root));
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_ARTIFACT_PREVIEW_BYTES;

    this.unsubscribes.push(
      options.eventBus.on('companion.approval.requested', ({ payload }) => {
        this.publish({ kind: 'approval.requested', payload, emittedAt: new Date().toISOString() });
      }),
      options.eventBus.on('companion.approval.resolved', ({ payload }) => {
        this.publish({ kind: 'approval.resolved', payload, emittedAt: new Date().toISOString() });
      }),
      options.eventBus.on('companion.artifact.created', ({ payload, preview, channelId }) => {
        this.registerPreview(payload, preview);
        this.publish({
          kind: 'artifact.created',
          payload,
          ...(channelId ? { channelId } : {}),
          emittedAt: new Date().toISOString(),
        });
      }),
      options.eventBus.on('companion.tool.activity', ({ payload, channelId }) => {
        this.publish({
          kind: 'tool.activity',
          payload,
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

  getPreviewSource(artifactId: string): CompanionArtifactPreviewEntry | null {
    return this.previews.get(artifactId) ?? null;
  }

  private publish(envelope: CompanionEventEnvelope): void {
    for (const subscriber of [...this.subscribers]) {
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

  private registerPreview(
    payload: CompanionArtifactCreatedPayload,
    preview: CompanionArtifactPreviewSource | undefined,
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
    const insideRoot = this.previewRoots.some((root) => isPathInsideRoot(preview.localPath, root));
    if (!insideRoot) {
      log.warn('Rejected artifact preview registration: path outside preview roots', {
        artifactId: payload.id,
      });
      return;
    }
    if (this.previews.size >= MAX_PREVIEW_REGISTRY_ENTRIES) {
      const oldest = this.previews.keys().next().value;
      if (oldest !== undefined) this.previews.delete(oldest);
    }
    this.previews.set(payload.id, {
      artifactId: payload.id,
      localPath: resolvePath(preview.localPath),
      mediaType: preview.mediaType,
      sizeBytes: preview.sizeBytes,
      previewable: preview.sizeBytes <= this.maxPreviewBytes,
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
  if (kind !== 'artifact.created' && kind !== 'tool.activity') {
    throw new Error('companion.event.publish: kind must be artifact.created or tool.activity');
  }
  if (!isRecord(params.payload)) {
    throw new Error('companion.event.publish: payload must be an object');
  }
  const channelId = optionalString(params, 'channelId', 256);
  const payload = params.payload;

  if (kind === 'tool.activity') {
    const phase = requireString(payload, 'phase', 32);
    if (!COMPANION_TOOL_ACTIVITY_PHASES.includes(phase as CompanionToolActivityPhase)) {
      throw new Error('companion.event.publish: invalid tool activity phase');
    }
    const detail = optionalString(payload, 'detail', 200);
    const parsed: CompanionToolActivityPayload = {
      id: requireString(payload, 'id', 160),
      tool: requireString(payload, 'tool', 120),
      phase: phase as CompanionToolActivityPhase,
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
