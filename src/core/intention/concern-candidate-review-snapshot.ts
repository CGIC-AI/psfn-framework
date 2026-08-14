import {
  VALID_MEMORY_TYPES,
  type PurrMemory,
} from '../../faculties/memory/types.js';
import { isRecord } from '../../shared/utils/types.js';
import type { ConcernCandidate } from './concern-candidate-types.js';

export const MAX_CANDIDATE_TEXT_CHARS = 500;
export const MAX_CONTEXT_MESSAGES = 12;
export const MAX_RELATED_MEMORIES = 8;

export type DurableConcernCandidateReviewFields = Omit<
  ConcernCandidate,
  | 'id'
  | 'dedupeKey'
  | 'durableConcernId'
  | 'source'
  | 'priorityHint'
  | 'evidenceRefs'
  | 'createdAt'
  | 'contactId'
  | 'dueAt'
  | 'formationVAD'
>;

export type DurableConcernCandidateReviewSnapshot =
  DurableConcernCandidateReviewFields & { schemaVersion: 1 };

export function buildDurableCandidateReviewSnapshot(
  candidate: ConcernCandidate,
): DurableConcernCandidateReviewSnapshot {
  return {
    schemaVersion: 1,
    title: candidate.title,
    summary: candidate.summary,
    followUpHint: candidate.followUpHint,
    channelId: candidate.channelId,
    triggerReason: candidate.triggerReason,
    sourceRef: candidate.sourceRef,
    sourceMessageIds: candidate.sourceMessageIds,
    conversationContext: candidate.conversationContext,
    relatedMemoryContext: candidate.relatedMemoryContext,
    ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
    ...(candidate.temporalResolution
      ? { temporalResolution: candidate.temporalResolution }
      : {}),
  };
}

export function parseDurableCandidateReviewSnapshot(
  value: unknown,
): DurableConcernCandidateReviewFields {
  if (value === undefined || value === null) {
    throw new Error('Durable concern candidate review snapshot is missing');
  }
  if (!isRecord(value)) {
    throw new Error('Durable concern candidate review snapshot must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error(
      `Durable concern candidate review snapshot has unsupported schemaVersion ${String(value.schemaVersion)}; expected 1`,
    );
  }
  const requireBoundedText = (field: string, maxChars = MAX_CANDIDATE_TEXT_CHARS): string => {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxChars) {
      throw new Error(`Durable concern candidate review snapshot ${field} is invalid`);
    }
    return raw;
  };
  const triggerReason = value.triggerReason;
  if (typeof triggerReason !== 'string' || ![
    'manual',
    'reflection_output',
    'response_turn',
    'interval',
    'context_threshold',
    'interval_and_threshold',
    'observed_count',
    'observed_time',
    'direct_mention',
    'high_salience',
    'backlog_lag',
  ].includes(triggerReason)) {
    throw new Error('Durable concern candidate review snapshot triggerReason is invalid');
  }
  const followUpHint = value.followUpHint;
  if (followUpHint !== 'internal_only' && followUpHint !== 'possible_follow_up') {
    throw new Error('Durable concern candidate review snapshot followUpHint is invalid');
  }
  if (!Array.isArray(value.sourceMessageIds)
    || value.sourceMessageIds.some(id => !Number.isSafeInteger(id))) {
    throw new Error('Durable concern candidate review snapshot sourceMessageIds is invalid');
  }
  if (!Array.isArray(value.conversationContext)
    || value.conversationContext.length > MAX_CONTEXT_MESSAGES) {
    throw new Error('Durable concern candidate review snapshot conversationContext is invalid');
  }
  const conversationContext = value.conversationContext.map((entry, index) => {
    if (!isRecord(entry)
      || !Number.isSafeInteger(entry.id)
      || typeof entry.content !== 'string'
      || entry.content.length > MAX_CANDIDATE_TEXT_CHARS
      || (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'system' && entry.role !== 'tool')
      || (entry.authorId !== undefined && typeof entry.authorId !== 'string')
      || (entry.authorName !== undefined && typeof entry.authorName !== 'string')
      || (entry.timestamp !== undefined && !Number.isFinite(entry.timestamp))) {
      throw new Error(`Durable concern candidate review snapshot conversationContext[${index}] is invalid`);
    }
    return {
      id: entry.id as number,
      role: entry.role as ConcernCandidate['conversationContext'][number]['role'],
      content: entry.content,
      ...(typeof entry.authorId === 'string' ? { authorId: entry.authorId } : {}),
      ...(typeof entry.authorName === 'string' ? { authorName: entry.authorName } : {}),
      ...(typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}),
    };
  });
  if (!Array.isArray(value.relatedMemoryContext)
    || value.relatedMemoryContext.length > MAX_RELATED_MEMORIES) {
    throw new Error('Durable concern candidate review snapshot relatedMemoryContext is invalid');
  }
  const relatedMemoryContext = value.relatedMemoryContext.map((memory, index) => {
    if (!isRecord(memory)
      || typeof memory.id !== 'string'
      || typeof memory.type !== 'string'
      || !VALID_MEMORY_TYPES.includes(memory.type as PurrMemory['type'])
      || typeof memory.text !== 'string'
      || memory.text.length > MAX_CANDIDATE_TEXT_CHARS
      || !Number.isFinite(memory.importance)
      || !Number.isFinite(memory.confidence)
      || !Number.isFinite(memory.salience)
      || typeof memory.sourceRef !== 'string') {
      throw new Error(`Durable concern candidate review snapshot relatedMemoryContext[${index}] is invalid`);
    }
    return {
      id: memory.id,
      type: memory.type as PurrMemory['type'],
      text: memory.text,
      importance: memory.importance as number,
      confidence: memory.confidence as number,
      salience: memory.salience as number,
      sourceRef: memory.sourceRef,
    };
  });
  if (value.turnId !== undefined && typeof value.turnId !== 'string') {
    throw new Error('Durable concern candidate review snapshot turnId is invalid');
  }
  const temporalResolution = parseTemporalResolution(value.temporalResolution);
  return {
    title: requireBoundedText('title'),
    summary: requireBoundedText('summary'),
    followUpHint,
    channelId: requireBoundedText('channelId'),
    triggerReason: triggerReason as ConcernCandidate['triggerReason'],
    sourceRef: requireBoundedText('sourceRef'),
    sourceMessageIds: [...value.sourceMessageIds] as number[],
    conversationContext,
    relatedMemoryContext,
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    ...(temporalResolution ? { temporalResolution } : {}),
  };
}

function parseTemporalResolution(
  value: unknown,
): ConcernCandidate['temporalResolution'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.timeZone !== 'string' || value.timeZone.trim().length === 0) {
    throw new Error('Durable concern candidate review snapshot temporalResolution is invalid');
  }
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date());
  } catch {
    throw new Error('Durable concern candidate review snapshot temporalResolution timezone is invalid');
  }
  if (value.status === 'resolved'
    && typeof value.dueAt === 'string'
    && Number.isFinite(Date.parse(value.dueAt))) {
    return {
      status: 'resolved',
      dueAt: new Date(Date.parse(value.dueAt)).toISOString(),
      timeZone: value.timeZone,
    };
  }
  if (value.status === 'needs_clarification' && value.reason === 'unresolved_or_past') {
    return {
      status: 'needs_clarification',
      reason: 'unresolved_or_past',
      timeZone: value.timeZone,
    };
  }
  throw new Error('Durable concern candidate review snapshot temporalResolution is invalid');
}
