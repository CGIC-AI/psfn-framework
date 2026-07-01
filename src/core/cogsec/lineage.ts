import type { CompactionSummary, SessionEntry } from '../session/types.js';
import type {
  CogSecAffectedMessageRange,
  CogSecEvent,
} from './events.js';
import type { MemoryProvenance, PurrMemory } from '../../faculties/memory/types.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';

export type CogSecLineageAction =
  | 'seal'
  | 'tombstone'
  | 'search_exclude'
  | 'revoke'
  | 'regenerate'
  | 'manual_review';

export type CogSecLineageClassification = 'tainted' | 'uncertain';

export type CogSecExternalArtifactClass =
  | 'focus_knowledge'
  | 'active_memory_cache'
  | 'episodic_landmark'
  | 'profile_artifact'
  | 'contact_profile'
  | 'persona_artifact';

export interface CogSecLineageSource {
  caseId: string;
  sourceChannelId: string;
  affectedLogicalSessionIds: string[];
  affectedMessageRanges: CogSecAffectedMessageRange[];
}

export interface CogSecLineageSessionReader {
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[];
  getCompactionSummaries(channelId: string): CompactionSummary[];
}

export interface CogSecExternalLineageArtifact {
  artifactClass: CogSecExternalArtifactClass;
  id: string;
  sourceRef?: string;
  provenanceRefs?: readonly (string | CogSecStructuredProvenanceRef)[];
  provenance?: MemoryProvenance;
}

export interface CogSecStructuredProvenanceRef {
  kind: string;
  refId: string;
}

export interface CogSecLineageL0Ref {
  logicalSessionId: string;
  sourceChannelId?: string;
  messageId: number;
  classification: 'tainted';
  reason: string;
  actions: CogSecLineageAction[];
}

export interface CogSecLineageProjectionRef {
  channelId: string;
  messageId: number;
  classification: 'tainted';
  reason: string;
  actions: CogSecLineageAction[];
}

export interface CogSecLineageMemoryRef {
  id: string;
  classification: CogSecLineageClassification;
  reason: string;
  sourceRef?: string;
  provenanceRefs: string[];
  hasEmbedding: boolean;
  actions: CogSecLineageAction[];
}

export interface CogSecLineageCompactionRef {
  logicalSessionId: string;
  compactionId: number;
  coveredUpTo: number;
  classification: CogSecLineageClassification;
  reason: string;
  actions: CogSecLineageAction[];
}

export interface CogSecLineageExternalArtifactRef {
  artifactClass: CogSecExternalArtifactClass;
  id: string;
  classification: CogSecLineageClassification;
  reason: string;
  actions: CogSecLineageAction[];
}

export interface CogSecLineageGap {
  artifactClass:
    | 'memories'
    | 'compaction_summaries'
    | 'focus_knowledge'
    | 'active_memory_cache'
    | 'episodic_landmarks'
    | 'profile_artifacts'
    | 'contact_profiles'
    | 'persona_artifacts';
  reason: string;
}

export interface CogSecLineagePreview {
  caseId: string;
  sourceChannelId: string;
  affectedLogicalSessionIds: string[];
  l0Messages: CogSecLineageL0Ref[];
  transcriptProjectionRows: CogSecLineageProjectionRef[];
  memories: CogSecLineageMemoryRef[];
  embeddingMemoryRows: CogSecLineageMemoryRef[];
  compactionSummaries: CogSecLineageCompactionRef[];
  externalArtifacts: CogSecLineageExternalArtifactRef[];
  gaps: CogSecLineageGap[];
}

export interface BuildCogSecLineagePreviewInput {
  event: CogSecLineageSource | CogSecEvent;
  sessionReader?: CogSecLineageSessionReader;
  memoryStore?: Pick<MemoryStorePort, 'listMemories'>;
  externalArtifacts?: readonly CogSecExternalLineageArtifact[];
}

interface AffectedSpan {
  sourceChannelId?: string;
  logicalSessionId: string;
  messageIds: Set<number>;
  startEntryId?: number;
  endEntryId?: number;
  sessionWide: boolean;
}

interface ParsedRef {
  sessionId?: string;
  channelId?: string;
  messageIds: Set<number>;
  startEntryId?: number;
  endEntryId?: number;
}

interface MatchResult {
  classification: CogSecLineageClassification;
  reason: string;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function normalizeRange(
  range: CogSecAffectedMessageRange,
  fallbackLogicalSessionId: string,
  fallbackSourceChannelId: string,
): AffectedSpan {
  const messageIds = new Set<number>((range.messageIds ?? [])
    .filter((id): id is number => Number.isInteger(id) && id > 0));
  const startEntryId = normalizePositiveInteger(range.startEntryId);
  const endEntryId = normalizePositiveInteger(range.endEntryId);
  const sourceChannelId = range.sourceChannelId ?? fallbackSourceChannelId;
  return {
    ...(sourceChannelId ? { sourceChannelId } : {}),
    logicalSessionId: range.logicalSessionId ?? fallbackLogicalSessionId,
    messageIds,
    ...(startEntryId !== undefined ? { startEntryId } : {}),
    ...(endEntryId !== undefined ? { endEntryId } : {}),
    sessionWide: messageIds.size === 0 && startEntryId === undefined && endEntryId === undefined,
  };
}

function buildAffectedSpans(event: CogSecLineageSource | CogSecEvent): AffectedSpan[] {
  const spans: AffectedSpan[] = [];
  if (event.affectedMessageRanges.length > 0) {
    for (const range of event.affectedMessageRanges) {
      spans.push(normalizeRange(range, range.logicalSessionId ?? event.sourceChannelId, event.sourceChannelId));
    }
    return spans;
  }
  const sessions = uniqueStrings([
    ...event.affectedLogicalSessionIds,
    event.sourceChannelId,
  ]);
  for (const sessionId of sessions) {
    spans.push({
      sourceChannelId: event.sourceChannelId,
      logicalSessionId: sessionId,
      messageIds: new Set(),
      sessionWide: true,
    });
  }
  return spans;
}

function spanHasMessageGranularity(span: AffectedSpan): boolean {
  return span.messageIds.size > 0 || span.startEntryId !== undefined || span.endEntryId !== undefined;
}

function messageIdInSpan(id: number, span: AffectedSpan): boolean {
  if (span.sessionWide) return true;
  if (span.messageIds.has(id)) return true;
  if (span.startEntryId !== undefined && id < span.startEntryId) return false;
  if (span.endEntryId !== undefined && id > span.endEntryId) return false;
  return span.startEntryId !== undefined || span.endEntryId !== undefined;
}

function rangesIntersect(
  leftStart: number | undefined,
  leftEnd: number | undefined,
  rightStart: number | undefined,
  rightEnd: number | undefined,
): boolean {
  if (leftStart === undefined && leftEnd === undefined) return true;
  if (rightStart === undefined && rightEnd === undefined) return true;
  const normalizedLeftStart = leftStart ?? leftEnd ?? 1;
  const normalizedLeftEnd = leftEnd ?? leftStart ?? Number.MAX_SAFE_INTEGER;
  const normalizedRightStart = rightStart ?? rightEnd ?? 1;
  const normalizedRightEnd = rightEnd ?? rightStart ?? Number.MAX_SAFE_INTEGER;
  return normalizedLeftStart <= normalizedRightEnd && normalizedRightStart <= normalizedLeftEnd;
}

function parseLineRange(value: string): { startEntryId?: number; endEntryId?: number } {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value.trim());
  if (!match) return {};
  const startEntryId = Number.parseInt(match[1], 10);
  const endEntryId = Number.parseInt(match[2] || match[1], 10);
  return {
    ...(startEntryId > 0 ? { startEntryId } : {}),
    ...(endEntryId > 0 ? { endEntryId } : {}),
  };
}

function parseStructuredRef(ref: string): ParsedRef {
  const parsed: ParsedRef = {
    messageIds: new Set(),
  };
  const tokens = ref.split('|');
  const leadingChannel = tokens[0]?.split(':extract')[0]?.trim();
  if (leadingChannel && leadingChannel !== ref && leadingChannel.length > 0) {
    parsed.channelId = leadingChannel;
  }

  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator <= 0) continue;
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1).trim();
    if (!value) continue;
    if (key === 'session') {
      parsed.sessionId = value;
    } else if (key === 'channel') {
      parsed.channelId = value;
    } else if (key === 'message' || key === 'messageId') {
      const id = Number.parseInt(value, 10);
      if (Number.isInteger(id) && id > 0) parsed.messageIds.add(id);
    } else if (key === 'lines') {
      Object.assign(parsed, parseLineRange(value));
    }
  }
  return parsed;
}

function refMatchesSpans(ref: string, spans: readonly AffectedSpan[]): MatchResult | null {
  const parsed = parseStructuredRef(ref);
  const hasSessionRef = Boolean(parsed.sessionId || parsed.channelId);
  const hasMessageIdRef = parsed.messageIds.size > 0;
  const hasLineRangeRef = parsed.startEntryId !== undefined || parsed.endEntryId !== undefined;
  const hasMessageRef = hasMessageIdRef || hasLineRangeRef;
  for (const span of spans) {
    const sessionMatches = parsed.sessionId === span.logicalSessionId
      || parsed.channelId === span.logicalSessionId
      || parsed.channelId === span.sourceChannelId;
    if (!sessionMatches) continue;
    if (!spanHasMessageGranularity(span)) {
      return {
        classification: 'tainted',
        reason: 'structured_ref_matches_affected_session',
      };
    }
    if (parsed.messageIds.size > 0 && [...parsed.messageIds].some(id => messageIdInSpan(id, span))) {
      return {
        classification: 'tainted',
        reason: 'structured_ref_message_id_intersects_affected_range',
      };
    }
    if (hasLineRangeRef
      &&
      rangesIntersect(
        parsed.startEntryId,
        parsed.endEntryId,
        span.startEntryId,
        span.endEntryId,
      )
    ) {
      return {
        classification: 'tainted',
        reason: 'structured_ref_line_range_intersects_affected_range',
      };
    }
    if (hasSessionRef && !hasMessageRef) {
      return {
        classification: 'uncertain',
        reason: 'structured_ref_session_match_without_message_granularity',
      };
    }
  }
  return null;
}

function provenanceMatchesSpans(
  provenance: MemoryProvenance | undefined,
  spans: readonly AffectedSpan[],
): MatchResult | null {
  if (!provenance) return null;
  for (const span of spans) {
    const sessionMatches = provenance.sessionId === span.logicalSessionId
      || provenance.channelId === span.logicalSessionId
      || provenance.channelId === span.sourceChannelId;
    if (!sessionMatches) continue;
    const hasSourceMessageIds = Boolean(provenance.sourceMessageIds?.length);
    const hasSourceSpan = provenance.sourceSpanStartMessageId !== undefined
      || provenance.sourceSpanEndMessageId !== undefined;
    if (!spanHasMessageGranularity(span)) {
      return {
        classification: 'tainted',
        reason: 'provenance_matches_affected_session',
      };
    }
    if (provenance.sourceMessageIds?.some(id => messageIdInSpan(id, span))) {
      return {
        classification: 'tainted',
        reason: 'provenance_message_id_intersects_affected_range',
      };
    }
    if (hasSourceSpan
      &&
      rangesIntersect(
        provenance.sourceSpanStartMessageId,
        provenance.sourceSpanEndMessageId,
        span.startEntryId,
        span.endEntryId,
      )
    ) {
      return {
        classification: 'tainted',
        reason: 'provenance_span_intersects_affected_range',
      };
    }
    if (hasSourceMessageIds || hasSourceSpan) return null;
    return {
      classification: 'uncertain',
      reason: 'provenance_session_match_without_message_granularity',
    };
  }
  return null;
}

function memoryMatchesSpans(memory: PurrMemory, spans: readonly AffectedSpan[]): MatchResult | null {
  const provenanceMatch = provenanceMatchesSpans(memory.provenance, spans);
  if (provenanceMatch) return provenanceMatch;
  const refs = [
    memory.sourceRef,
    ...(memory.provenanceRefs ?? []),
  ].filter(ref => ref.trim().length > 0);
  for (const ref of refs) {
    const match = refMatchesSpans(ref, spans);
    if (match) return match;
  }
  return null;
}

function normalizeProvenanceRef(ref: string | CogSecStructuredProvenanceRef): string | null {
  if (typeof ref === 'string') {
    const trimmed = ref.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const kind = ref.kind.trim();
  const refId = ref.refId.trim();
  if (!kind || !refId) return null;
  if (kind === 'session') return `session:${refId}`;
  if (kind === 'turn') return `turn:${refId}`;
  if (kind === 'l0_span') return `l0_span:${refId}`;
  return `${kind}:${refId}`;
}

function artifactMatchesSpans(
  artifact: CogSecExternalLineageArtifact,
  spans: readonly AffectedSpan[],
): MatchResult | null {
  const provenanceMatch = provenanceMatchesSpans(artifact.provenance, spans);
  if (provenanceMatch) return provenanceMatch;
  const refs = [
    artifact.sourceRef,
    ...(artifact.provenanceRefs ?? []).map(normalizeProvenanceRef),
  ].filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0);
  for (const ref of refs) {
    const match = refMatchesSpans(ref, spans);
    if (match) return match;
  }
  return null;
}

function buildL0Refs(spans: readonly AffectedSpan[], sessionReader: CogSecLineageSessionReader | undefined): CogSecLineageL0Ref[] {
  const refs = new Map<string, CogSecLineageL0Ref>();
  for (const span of spans) {
    const messageIds = new Set(span.messageIds);
    if (messageIds.size === 0 && span.startEntryId !== undefined && span.endEntryId !== undefined && sessionReader) {
      for (const entry of sessionReader.getEntriesInRange(span.logicalSessionId, span.startEntryId, span.endEntryId)) {
        messageIds.add(entry.id);
      }
    }
    for (const messageId of messageIds) {
      refs.set(`${span.logicalSessionId}:${messageId}`, {
        logicalSessionId: span.logicalSessionId,
        ...(span.sourceChannelId ? { sourceChannelId: span.sourceChannelId } : {}),
        messageId,
        classification: 'tainted',
        reason: 'operator_selected_l0_message',
        actions: ['seal', 'tombstone'],
      });
    }
  }
  return [...refs.values()].sort((left, right) => (
    left.logicalSessionId.localeCompare(right.logicalSessionId) || left.messageId - right.messageId
  ));
}

function buildProjectionRefs(l0Refs: readonly CogSecLineageL0Ref[]): CogSecLineageProjectionRef[] {
  return l0Refs.map(ref => ({
    channelId: ref.logicalSessionId,
    messageId: ref.messageId,
    classification: 'tainted',
    reason: 'projection_row_for_affected_l0_message',
    actions: ['search_exclude', 'regenerate'],
  }));
}

function buildCompactionRefs(
  spans: readonly AffectedSpan[],
  sessionReader: CogSecLineageSessionReader | undefined,
): CogSecLineageCompactionRef[] {
  if (!sessionReader) return [];
  const refs: CogSecLineageCompactionRef[] = [];
  for (const span of spans) {
    for (const summary of sessionReader.getCompactionSummaries(span.logicalSessionId)) {
      const minimumAffectedMessageId = span.startEntryId
        ?? (span.messageIds.size > 0 ? Math.min(...span.messageIds) : undefined);
      const coversAffectedRange = span.sessionWide
        || minimumAffectedMessageId === undefined
        || summary.coveredUpTo >= minimumAffectedMessageId;
      if (!coversAffectedRange) continue;
      refs.push({
        logicalSessionId: span.logicalSessionId,
        compactionId: summary.id,
        coveredUpTo: summary.coveredUpTo,
        classification: span.sessionWide ? 'tainted' : 'uncertain',
        reason: span.sessionWide
          ? 'compaction_summary_belongs_to_affected_session'
          : 'compaction_summary_covers_or_may_cover_affected_l0_range',
        actions: ['regenerate'],
      });
    }
  }
  return refs.sort((left, right) => (
    left.logicalSessionId.localeCompare(right.logicalSessionId) || left.compactionId - right.compactionId
  ));
}

function gap(artifactClass: CogSecLineageGap['artifactClass'], reason: string): CogSecLineageGap {
  return { artifactClass, reason };
}

export async function buildCogSecLineagePreview(
  input: BuildCogSecLineagePreviewInput,
): Promise<CogSecLineagePreview> {
  const affectedLogicalSessionIds = uniqueStrings([
    ...input.event.affectedLogicalSessionIds,
    input.event.sourceChannelId,
  ]);
  const event: CogSecLineageSource = {
    caseId: input.event.caseId,
    sourceChannelId: input.event.sourceChannelId,
    affectedLogicalSessionIds,
    affectedMessageRanges: input.event.affectedMessageRanges.map(range => ({ ...range })),
  };
  const spans = buildAffectedSpans(event);
  const l0Messages = buildL0Refs(spans, input.sessionReader);
  const transcriptProjectionRows = buildProjectionRefs(l0Messages);
  const gaps: CogSecLineageGap[] = [];

  const memories: CogSecLineageMemoryRef[] = [];
  if (input.memoryStore) {
    for (const memory of await input.memoryStore.listMemories()) {
      const match = memoryMatchesSpans(memory, spans);
      if (!match) continue;
      memories.push({
        id: memory.id,
        classification: match.classification,
        reason: match.reason,
        ...(memory.sourceRef ? { sourceRef: memory.sourceRef } : {}),
        provenanceRefs: [...(memory.provenanceRefs ?? [])],
        hasEmbedding: Boolean(memory.embedding),
        actions: match.classification === 'tainted'
          ? ['revoke', 'regenerate']
          : ['manual_review'],
      });
    }
  } else {
    gaps.push(gap('memories', 'memory_store_not_provided'));
  }
  memories.sort((left, right) => left.id.localeCompare(right.id));

  const compactionSummaries = buildCompactionRefs(spans, input.sessionReader);
  if (!input.sessionReader) {
    gaps.push(gap('compaction_summaries', 'session_reader_not_provided'));
  }

  const externalArtifacts: CogSecLineageExternalArtifactRef[] = [];
  if (input.externalArtifacts) {
    for (const artifact of input.externalArtifacts) {
      const match = artifactMatchesSpans(artifact, spans);
      if (!match) continue;
      externalArtifacts.push({
        artifactClass: artifact.artifactClass,
        id: artifact.id,
        classification: match.classification,
        reason: match.reason,
        actions: match.classification === 'tainted'
          ? ['revoke', 'regenerate']
          : ['manual_review'],
      });
    }
  } else {
    gaps.push(gap('focus_knowledge', 'external_artifact_provider_not_provided'));
    gaps.push(gap('active_memory_cache', 'external_artifact_provider_not_provided'));
    gaps.push(gap('episodic_landmarks', 'external_artifact_provider_not_provided'));
    gaps.push(gap('profile_artifacts', 'external_artifact_provider_not_provided'));
    gaps.push(gap('contact_profiles', 'external_artifact_provider_not_provided'));
    gaps.push(gap('persona_artifacts', 'external_artifact_provider_not_provided'));
  }
  externalArtifacts.sort((left, right) => (
    left.artifactClass.localeCompare(right.artifactClass) || left.id.localeCompare(right.id)
  ));

  return {
    caseId: event.caseId,
    sourceChannelId: event.sourceChannelId,
    affectedLogicalSessionIds,
    l0Messages,
    transcriptProjectionRows,
    memories,
    embeddingMemoryRows: memories.filter(memory => memory.hasEmbedding),
    compactionSummaries,
    externalArtifacts,
    gaps,
  };
}
