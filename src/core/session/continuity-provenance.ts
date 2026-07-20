import type { SessionEntryRole } from './types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import { decodeStoredChannelVisibility } from '../../system/trust/types.js';
import { isRecord } from '../../shared/utils/types.js';

export interface ContinuityEntryProvenance {
  kind: 'continuity';
  continuityUserId: string;
  sourceChannelId: string;
  /** Stored-value decode: ChannelPrivacy (legacy 'broadcast' decodes to 'public'). */
  sourceVisibility: ChannelPrivacy;
  sourceRole: SessionEntryRole;
  recordedAt: number;
  /**
   * Explicitly distinguishes L0-backed continuity from intentional ephemeral
   * continuity (for example internal reflection channels that never persist a
   * session journal). Absent means a legacy row whose authority is unproven.
   */
  sourcePersistence?: 'l0' | 'non_persistent';
  /**
   * Immutable L0 id in the source session journal. Older continuity rows may
   * lack this field; persisted turn-record reads withhold those rows because
   * their current CogSec state cannot be proven.
   */
  sourceEntryId?: number;
}

function parseMetadataObject(metadata?: string): Record<string, unknown> | null {
  if (!metadata) return null;

  try {
    const parsed: unknown = JSON.parse(metadata);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseContinuityEntryProvenance(metadata?: string): ContinuityEntryProvenance | null {
  const parsed = parseMetadataObject(metadata);
  if (!parsed || !isRecord(parsed.continuity)) return null;

  const provenance = parsed.continuity;
  const kind = provenance.kind;
  const continuityUserId = provenance.continuityUserId;
  const sourceChannelId = provenance.sourceChannelId;
  // Continuity provenance is persisted; decode legacy 'semi_private' records.
  const sourceVisibility = decodeStoredChannelVisibility(provenance.sourceVisibility);
  const sourceRole = provenance.sourceRole;
  const recordedAt = provenance.recordedAt;
  const sourcePersistence = provenance.sourcePersistence;
  const sourceEntryId = provenance.sourceEntryId;

  if (
    kind !== 'continuity'
    || typeof continuityUserId !== 'string'
    || typeof sourceChannelId !== 'string'
    || sourceVisibility === undefined
    || sourceRole !== 'user'
    && sourceRole !== 'assistant'
    && sourceRole !== 'system'
    || typeof recordedAt !== 'number'
    || !Number.isFinite(recordedAt)
    || sourcePersistence !== undefined
    && sourcePersistence !== 'l0'
    && sourcePersistence !== 'non_persistent'
    || sourceEntryId !== undefined
    && (typeof sourceEntryId !== 'number'
      || !Number.isInteger(sourceEntryId)
      || sourceEntryId <= 0)
  ) {
    return null;
  }

  return {
    kind,
    continuityUserId,
    sourceChannelId,
    sourceVisibility,
    sourceRole,
    recordedAt,
    ...(sourcePersistence !== undefined ? { sourcePersistence } : {}),
    ...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
  };
}

export function buildContinuityEntryMetadata(params: {
  continuityUserId: string;
  sourceChannelId: string;
  sourceVisibility: ChannelPrivacy;
  sourceRole: SessionEntryRole;
  recordedAt: number;
  sourcePersistence?: 'l0' | 'non_persistent';
  sourceEntryId?: number;
  existingMetadata?: string;
}): string {
  const continuity: ContinuityEntryProvenance = {
    kind: 'continuity',
    continuityUserId: params.continuityUserId,
    sourceChannelId: params.sourceChannelId,
    sourceVisibility: params.sourceVisibility,
    sourceRole: params.sourceRole,
    recordedAt: params.recordedAt,
    ...(params.sourcePersistence !== undefined
      ? { sourcePersistence: params.sourcePersistence }
      : params.sourceEntryId !== undefined
        ? { sourcePersistence: 'l0' as const }
        : {}),
    ...(params.sourceEntryId !== undefined ? { sourceEntryId: params.sourceEntryId } : {}),
  };

  const parsed = parseMetadataObject(params.existingMetadata);
  if (!parsed) {
    return JSON.stringify({ continuity });
  }

  return JSON.stringify({
    ...parsed,
    continuity,
  });
}
