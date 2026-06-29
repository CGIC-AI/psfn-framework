import {
  isHighIntimacySensitivityLevel,
  type ChannelVisibility,
  type TrustLevel,
} from '../../../system/trust/types.js';
import {
  evaluateMemoryPolicy,
  type ChannelMeta,
  type DisclosureBoundaryDirective,
} from '../../../system/trust/policy.js';
import type { PurrMemory } from '../types.js';
import {
  createEmptyMemoryWithheldSummary,
  incrementMemoryWithheldRelevanceBand,
  incrementMemoryWithheldReason,
  resolveMemoryWithheldRelevanceBand,
  type MemoryWithheldReasonTag,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import type { RetrievalAccessDecision } from './types.js';

const WITHHOLD_BOUNDARY_TAGS = new Set([
  'withhold',
  'withheld',
  'boundary_withhold',
  'do_not_disclose',
  'no_disclose',
  'private_boundary',
]);
const CONSENT_REQUIRED_BOUNDARY_TAGS = new Set([
  'consent_required',
  'requires_consent',
  'disclosure_requires_consent',
  'gate_consent',
]);
const ROOM_CONTEXT_SCOPE_TAGS = new Set([
  'group_memory',
  'room_context',
  'conversation',
  'channel',
]);

export interface RetrievalRoomVisibilityContext {
  currentChannelId: string;
  currentIsDirectMessage?: boolean;
  canonicalContactRoomIds?: ReadonlySet<string>;
}

function violatesHighIntimacyContactScope(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId'>,
  canonicalContactId?: string,
): boolean {
  if (!isHighIntimacySensitivityLevel(memory.sensitivity)) return false;
  if (!canonicalContactId) return false;
  return memory.contactId !== canonicalContactId;
}

function normalizeRoomId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function hasRoomContextScopeTag(memory: Pick<PurrMemory, 'scopeTags'>): boolean {
  for (const rawTag of memory.scopeTags ?? []) {
    const normalized = rawTag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (ROOM_CONTEXT_SCOPE_TAGS.has(normalized)) return true;
  }
  return false;
}

function resolveMemorySourceRoom(memory: Pick<PurrMemory, 'provenance' | 'scopeRef'>): {
  roomId?: string;
  inconsistent: boolean;
} {
  const scopedRoomId = memory.scopeRef?.kind === 'conversation'
    ? normalizeRoomId(memory.scopeRef.id)
    : undefined;
  const provenanceRoomId = normalizeRoomId(memory.provenance?.channelId);
  return {
    roomId: scopedRoomId ?? provenanceRoomId,
    inconsistent: scopedRoomId !== undefined
      && provenanceRoomId !== undefined
      && scopedRoomId !== provenanceRoomId,
  };
}

function requiresRoomProofWhenSourceMissing(
  memory: Pick<PurrMemory, 'scopeRef' | 'scopeTags'>,
  roomVisibility: RetrievalRoomVisibilityContext,
): boolean {
  if (roomVisibility.currentIsDirectMessage === undefined) return false;
  return memory.scopeRef?.kind === 'conversation'
    || hasRoomContextScopeTag(memory);
}

function evaluateRoomVisibilityDecision(
  memory: Pick<PurrMemory, 'sensitivity' | 'provenance' | 'scopeRef' | 'scopeTags'>,
  roomVisibility: RetrievalRoomVisibilityContext | undefined,
): RetrievalAccessDecision | undefined {
  const currentRoomId = normalizeRoomId(roomVisibility?.currentChannelId);
  if (!roomVisibility || !currentRoomId) return undefined;

  const source = resolveMemorySourceRoom(memory);
  if (source.inconsistent) {
    return {
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    };
  }
  if (!source.roomId) {
    if (requiresRoomProofWhenSourceMissing(memory, roomVisibility)) {
      return {
        allowed: false,
        rejectionKind: 'room_visibility',
        withheldReason: 'room_visibility.blocked',
      };
    }
    return undefined;
  }
  if (source.roomId === currentRoomId) return undefined;

  if (roomVisibility.currentIsDirectMessage === true) {
    if (roomVisibility.canonicalContactRoomIds?.has(source.roomId)) {
      return undefined;
    }
    return {
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    };
  }

  return {
    allowed: false,
    rejectionKind: 'room_visibility',
    withheldReason: 'room_visibility.blocked',
  };
}

export function evaluateRetrievalAccessDecision(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId' | 'consentFlags' | 'tags' | 'provenance' | 'scopeRef' | 'scopeTags'>,
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
    roomVisibility?: RetrievalRoomVisibilityContext;
  },
): RetrievalAccessDecision {
  const roomDecision = evaluateRoomVisibilityDecision(memory, options.roomVisibility);
  if (roomDecision) return roomDecision;

  if (violatesHighIntimacyContactScope(memory, options.canonicalContactId)) {
    return {
      allowed: false,
      rejectionKind: 'contact_scope',
      withheldReason: 'contact_scope.high_intimacy',
    };
  }

  const policy = evaluateMemoryPolicy({
    trustLevel: options.trustLevel,
    channelVisibility: options.channelVisibility,
    memorySensitivity: memory.sensitivity,
    consentFlags: memory.consentFlags,
    disclosureBoundary: resolveDisclosureBoundaryDirective(memory, options.channelMeta),
    operatorApproval: options.operatorApproval,
  });
  if (policy.decision === 'allow') {
    return { allowed: true };
  }

  if (
    policy.reasonTag === 'trust.ceiling_exceeded'
    || policy.reasonTag === 'visibility.channel_restricted'
  ) {
    return {
      allowed: false,
      rejectionKind: 'sensitivity',
      withheldReason: policy.reasonTag,
    };
  }

  return {
    allowed: false,
    rejectionKind: 'policy',
    withheldReason: policy.reasonTag as Exclude<
      MemoryWithheldReasonTag,
      'contact_scope.high_intimacy' | 'room_visibility.blocked'
    >,
  };
}

export function summarizeWithheldMemories<T extends Pick<PurrMemory, 'id' | 'sensitivity' | 'contactId' | 'consentFlags' | 'tags' | 'provenance' | 'scopeRef' | 'scopeTags'> & { similarity?: number }>(
  memories: readonly T[],
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
    roomVisibility?: RetrievalRoomVisibilityContext;
  },
): { summary?: MemoryWithheldSummary; withheldIds: string[] } {
  const summary = createEmptyMemoryWithheldSummary();
  const withheldIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const memory of memories) {
    if (seenIds.has(memory.id)) continue;
    seenIds.add(memory.id);

    const decision = evaluateRetrievalAccessDecision(memory, options);
    if (!decision.allowed && decision.withheldReason) {
      incrementMemoryWithheldReason(summary, decision.withheldReason);
      incrementMemoryWithheldRelevanceBand(
        summary,
        resolveMemoryWithheldRelevanceBand(memory.similarity),
      );
      withheldIds.add(memory.id);
    }
  }

  return {
    ...(summary.totalCount > 0 ? { summary } : {}),
    withheldIds: [...withheldIds],
  };
}

export function mergeMemoryWithheldSummaries(
  ...summaries: Array<MemoryWithheldSummary | undefined>
): MemoryWithheldSummary | undefined {
  let merged: MemoryWithheldSummary | undefined;
  for (const summary of summaries) {
    if (!summary || summary.totalCount <= 0) continue;
    merged ??= { totalCount: 0, reasonCounts: {}, relevanceBands: {} };
    merged.totalCount += summary.totalCount;
    for (const [reason, count] of Object.entries(summary.reasonCounts)) {
      if (!count || count <= 0) continue;
      const reasonKey = reason as keyof MemoryWithheldSummary['reasonCounts'];
      merged.reasonCounts[reasonKey] = (merged.reasonCounts[reasonKey] ?? 0) + count;
    }
    for (const [band, count] of Object.entries(summary.relevanceBands ?? {})) {
      if (!count || count <= 0) continue;
      const bandKey = band as keyof NonNullable<MemoryWithheldSummary['relevanceBands']>;
      merged.relevanceBands ??= {};
      merged.relevanceBands[bandKey] = (merged.relevanceBands[bandKey] ?? 0) + count;
    }
  }
  return merged;
}

function normalizeBoundaryTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hasBoundaryDirectiveTag(
  tags: readonly string[],
  candidates: ReadonlySet<string>,
): boolean {
  for (const rawTag of tags) {
    const normalized = normalizeBoundaryTag(rawTag);
    if (normalized.length === 0) continue;
    if (candidates.has(normalized)) return true;
  }
  return false;
}

function resolveDisclosureBoundaryDirective(
  memory: Pick<PurrMemory, 'tags'>,
  channelMeta?: ChannelMeta,
): DisclosureBoundaryDirective | undefined {
  const withhold = hasBoundaryDirectiveTag(memory.tags, WITHHOLD_BOUNDARY_TAGS);
  const consentRequired = hasBoundaryDirectiveTag(memory.tags, CONSENT_REQUIRED_BOUNDARY_TAGS);
  if (!withhold && !consentRequired) return undefined;

  return {
    withhold,
    consentRequired,
    consentGranted: channelMeta?.disclosureConsentGranted === true,
  };
}
