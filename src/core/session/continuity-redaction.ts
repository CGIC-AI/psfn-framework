import { isCogSecInvalidatedSummaryContent, isCogSecTombstoneContent } from '../cogsec/tombstones.js';
import { isRecord, toRecordView } from '../../shared/utils/types.js';
import { parseContinuityEntryProvenance } from './continuity-provenance.js';
import type { SessionEntry } from './types.js';
import { shouldPersistSessionChannel } from './session-channel-persistence.js';

export const REDACTED_SESSION_ENTRY_PLACEHOLDER =
  '[redacted: source entry removed from the session journal]';

export type ContinuityEntryRangeResolver = (
  channelId: string,
  minId: number,
  maxId: number,
) => SessionEntry[];

export type ContinuityEntryWithheldReason =
  | 'missing_source_ref'
  | 'resolver_error'
  | 'source_absent'
  | 'source_identity_mismatch'
  | 'source_redacted';

export interface ContinuityEntryWithheld {
  sourceChannelId: string;
  sourceEntryId?: number;
  reason: ContinuityEntryWithheldReason;
}

export interface ContinuityEntryResolution {
  entries: SessionEntry[];
  withheld: ContinuityEntryWithheld[];
}

interface ContinuitySourceRef {
  entry: SessionEntry;
  sourceChannelId: string;
  sourceEntryId: number;
}

function isValidL0Id(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRedactedContent(content: unknown): boolean {
  return typeof content === 'string'
    && (isCogSecTombstoneContent(content) || isCogSecInvalidatedSummaryContent(content));
}

function readContinuitySourceRef(value: unknown): ContinuitySourceRef | null {
  if (!isRecord(value)) return null;
  const entry = value as unknown as SessionEntry;
  const sourceChannelId = typeof entry.channelId === 'string' ? entry.channelId.trim() : '';
  const provenance = parseContinuityEntryProvenance(entry.metadata);
  if (!sourceChannelId || !provenance || !isValidL0Id(provenance.sourceEntryId)) return null;
  return {
    entry,
    sourceChannelId,
    sourceEntryId: provenance.sourceEntryId,
  };
}

function sourceEntryMatchesContinuity(
  source: SessionEntry,
  ref: ContinuitySourceRef,
): boolean {
  const provenance = parseContinuityEntryProvenance(ref.entry.metadata);
  if (!provenance) return false;
  return source.id === ref.sourceEntryId
    && source.channelId === ref.sourceChannelId
    && source.role === provenance.sourceRole
    && source.timestamp === provenance.recordedAt
    && (source.originChannelId ?? source.channelId) === provenance.sourceChannelId;
}

function withRedactedContinuityContent(value: unknown): SessionEntry {
  if (!isRecord(value)) {
    return {
      content: REDACTED_SESSION_ENTRY_PLACEHOLDER,
    } as unknown as SessionEntry;
  }
  const entry = toRecordView(value);
  return {
    ...entry,
    content: REDACTED_SESSION_ENTRY_PLACEHOLDER,
  } as unknown as SessionEntry;
}

/**
 * Resolve frozen continuity copies against their immutable origin L0 rows.
 * Calls are grouped into one inclusive range per source session and bounded by
 * the supplied continuity array. Every unprovable state heals to a redaction
 * notice; origin resolver failures never expose the secondary-index plaintext.
 */
export function resolveContinuityEntryContent(
  entries: readonly SessionEntry[],
  resolve: ContinuityEntryRangeResolver,
): ContinuityEntryResolution {
  if (entries.length === 0) return { entries: [], withheld: [] };

  const refsByIndex = new Map<number, ContinuitySourceRef>();
  const refsByChannel = new Map<string, ContinuitySourceRef[]>();
  for (const [index, value] of entries.entries()) {
    const ref = readContinuitySourceRef(value);
    if (!ref) continue;
    refsByIndex.set(index, ref);
    const refs = refsByChannel.get(ref.sourceChannelId) ?? [];
    refs.push(ref);
    refsByChannel.set(ref.sourceChannelId, refs);
  }

  const liveBySource = new Map<string, Map<number, SessionEntry>>();
  const failedSourceChannels = new Set<string>();
  for (const [sourceChannelId, refs] of refsByChannel.entries()) {
    const ids = refs.map(ref => ref.sourceEntryId);
    try {
      const live = new Map<number, SessionEntry>();
      for (const entry of resolve(sourceChannelId, Math.min(...ids), Math.max(...ids))) {
        live.set(entry.id, entry);
      }
      liveBySource.set(sourceChannelId, live);
    } catch {
      failedSourceChannels.add(sourceChannelId);
    }
  }

  const withheld: ContinuityEntryWithheld[] = [];
  const resolved = entries.map((value, index) => {
    const provenance = parseContinuityEntryProvenance(value.metadata);
    if (
      provenance?.sourcePersistence === 'non_persistent'
      && !shouldPersistSessionChannel(value.channelId)
    ) {
      return { ...value };
    }
    const ref = refsByIndex.get(index);
    let reason: ContinuityEntryWithheldReason | undefined;
    let sourceChannelId = typeof value.channelId === 'string' ? value.channelId : '';
    let sourceEntryId: number | undefined;

    if (!ref) {
      reason = 'missing_source_ref';
    } else {
      sourceChannelId = ref.sourceChannelId;
      sourceEntryId = ref.sourceEntryId;
      if (failedSourceChannels.has(ref.sourceChannelId)) {
        reason = 'resolver_error';
      } else {
        const source = liveBySource.get(ref.sourceChannelId)?.get(ref.sourceEntryId);
        if (!source) {
          reason = 'source_absent';
        } else if (!sourceEntryMatchesContinuity(source, ref)) {
          reason = 'source_identity_mismatch';
        } else if (isRedactedContent(source.content)) {
          reason = 'source_redacted';
        } else {
          return { ...ref.entry, content: source.content };
        }
      }
    }

    withheld.push({
      sourceChannelId,
      ...(sourceEntryId !== undefined ? { sourceEntryId } : {}),
      reason,
    });
    return withRedactedContinuityContent(value);
  });

  return { entries: resolved, withheld };
}
