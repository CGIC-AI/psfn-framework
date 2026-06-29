import { createHash } from 'node:crypto';
import type { EventBus } from '../../shared/event-bus.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import {
  COMPLETION_HANDOFF_METADATA_TYPE,
  COMPLETION_HANDOFF_SCHEMA_VERSION,
  type CompletionHandoffBlocker,
  type CompletionHandoffEmission,
  type CompletionHandoffInput,
  type CompletionHandoffRecord,
  type CompletionHandoffRef,
} from '../../shared/contracts/completion-handoff.js';
import type { SessionEntry } from '../session/types.js';
import type { SessionManager } from '../session/manager.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export {
  COMPLETION_HANDOFF_METADATA_TYPE,
  COMPLETION_HANDOFF_SCHEMA_VERSION,
} from '../../shared/contracts/completion-handoff.js';

export type {
  CompletionHandoffBlocker,
  CompletionHandoffEmission,
  CompletionHandoffInput,
  CompletionHandoffOrigin,
  CompletionHandoffRecord,
  CompletionHandoffRef,
  CompletionHandoffSource,
  CompletionHandoffStatus,
} from '../../shared/contracts/completion-handoff.js';

const COMPLETION_HANDOFF_AUTHOR_ID = 'system:completion-handoff';
const COMPLETION_HANDOFF_AUTHOR_NAME = 'CompletionHandoff';
const MAX_SUMMARY_CHARS = 700;
const RECENT_HANDOFF_SCAN_LIMIT = 100;

interface SessionStoreHandoffSink {
  getRecent(channelId: string, limit: number): SessionEntry[];
  append(entry: Omit<SessionEntry, 'id'>): number;
}

type SessionManagerHandoffSink = Pick<
  SessionManager,
  'getRecentMessages' | 'recordSystemMessage'
>;

const emittedDedupeKeys = new Set<string>();

export function resetCompletionHandoffDedupeForTests(): void {
  emittedDedupeKeys.clear();
}

export function buildCompletionHandoffDedupeKey(parts: readonly (string | undefined | null)[]): string {
  const seed = parts
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('|');
  return createHash('sha256')
    .update(seed || `completion-handoff:${Date.now()}`)
    .digest('hex')
    .slice(0, 32);
}

export function summarizeCompletionText(value: string | undefined, fallback = 'No textual result was returned.'): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  const summary = normalized || fallback;
  if (summary.length <= MAX_SUMMARY_CHARS) {
    return summary;
  }
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 3)}...`;
}

export function buildCompletionHandoff(input: CompletionHandoffInput): CompletionHandoffRecord {
  const dedupeKey = input.dedupeKey ?? buildCompletionHandoffDedupeKey([
    input.source,
    input.taskId,
    input.subagentId,
    input.shardId,
    input.status,
    input.origin?.originatingTaskId,
    input.origin?.originatingBeadId,
    input.origin?.requestId,
    input.origin?.turnId,
  ]);
  const createdAt = input.createdAt ?? Date.now();
  return {
    schemaVersion: COMPLETION_HANDOFF_SCHEMA_VERSION,
    handoffId: `handoff:${dedupeKey}`,
    dedupeKey,
    source: input.source,
    task: {
      id: input.taskId,
      ...(input.taskLabel ? { label: input.taskLabel } : {}),
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
      ...(input.shardId ? { shardId: input.shardId } : {}),
    },
    origin: {
      ...(input.origin?.originatingTaskId ? { originatingTaskId: input.origin.originatingTaskId } : {}),
      ...(input.origin?.originatingBeadId ? { originatingBeadId: input.origin.originatingBeadId } : {}),
      ...(input.origin?.sourceChannelId ? { sourceChannelId: input.origin.sourceChannelId } : {}),
      ...(input.origin?.sourceMessageId ? { sourceMessageId: input.origin.sourceMessageId } : {}),
      ...(input.origin?.requestId ? { requestId: input.origin.requestId } : {}),
      ...(input.origin?.turnId ? { turnId: input.origin.turnId } : {}),
    },
    status: input.status,
    result: {
      summary: summarizeCompletionText(input.resultSummary),
      partial: input.partialResult,
    },
    refs: {
      artifacts: normalizeRefs(input.artifactRefs),
      outputs: normalizeRefs(input.outputRefs),
    },
    validation: {
      performed: normalizeStringList(input.validationPerformed),
    },
    ...(input.blocker ? { blocker: normalizeBlocker(input.blocker) } : {}),
    recommendedNextAction: summarizeCompletionText(input.recommendedNextAction, 'Parent companion should decide the next step.'),
    privacy: {
      visibility: 'internal_companion_context',
      partnerNotification: 'policy_gated_companion_authored',
      rawWorkerCompletionForPartner: 'not_allowed',
    },
    createdAt,
  };
}

export async function emitCompletionHandoffToSessionStore(input: {
  eventBus: EventBus;
  sessionStore: SessionStoreHandoffSink;
  targetChannelId?: string;
  handoff: CompletionHandoffInput | CompletionHandoffRecord;
}): Promise<CompletionHandoffEmission> {
  const handoff = isCompletionHandoffRecord(input.handoff)
    ? input.handoff
    : buildCompletionHandoff(input.handoff);
  const targetChannelId = input.targetChannelId?.trim();
  if (isDuplicateHandoff(handoff.dedupeKey, targetChannelId, (channelId) => input.sessionStore.getRecent(channelId, RECENT_HANDOFF_SCAN_LIMIT))) {
    return { emitted: false, handoff, ...(targetChannelId ? { targetChannelId } : {}), duplicate: true };
  }

  let sessionEntryId: number | null = null;
  if (targetChannelId) {
    sessionEntryId = input.sessionStore.append({
      channelId: targetChannelId,
      role: 'system',
      content: renderCompletionHandoffForContext(handoff),
      authorId: COMPLETION_HANDOFF_AUTHOR_ID,
      authorName: COMPLETION_HANDOFF_AUTHOR_NAME,
      timestamp: handoff.createdAt,
      originChannelId: handoff.origin.sourceChannelId,
      channelVisibility: 'private',
      metadata: buildCompletionHandoffMetadata(handoff),
    });
  }

  emittedDedupeKeys.add(handoff.dedupeKey);
  await input.eventBus.emit('agent.completion_handoff', {
    handoff,
    ...(targetChannelId ? { targetChannelId } : {}),
    ...(sessionEntryId !== null ? { sessionEntryId } : {}),
    timestamp: Date.now(),
  });
  return {
    emitted: true,
    handoff,
    ...(targetChannelId ? { targetChannelId } : {}),
    ...(sessionEntryId !== null ? { sessionEntryId } : {}),
  };
}

export async function emitCompletionHandoffToSessionManager(input: {
  eventBus: EventBus;
  sessionManager: SessionManagerHandoffSink;
  targetChannelId: string;
  handoff: CompletionHandoffInput | CompletionHandoffRecord;
  authorId?: string;
  authorName?: string;
  isDirectMessage?: boolean;
  turn?: {
    turnId: string;
    requestId: string;
    sourceMessageId?: string;
  };
}): Promise<CompletionHandoffEmission> {
  const handoff = isCompletionHandoffRecord(input.handoff)
    ? input.handoff
    : buildCompletionHandoff(input.handoff);
  const targetChannelId = input.targetChannelId.trim();
  if (isDuplicateHandoff(handoff.dedupeKey, targetChannelId, (channelId) => input.sessionManager.getRecentMessages(channelId, RECENT_HANDOFF_SCAN_LIMIT))) {
    return { emitted: false, handoff, targetChannelId, duplicate: true };
  }

  const metadata = buildCompletionHandoffMetadata(handoff);
  const sessionEntryId = input.sessionManager.recordSystemMessage(
    targetChannelId,
    renderCompletionHandoffForContext(handoff),
    input.authorId?.trim() || COMPLETION_HANDOFF_AUTHOR_ID,
    input.authorName?.trim() || COMPLETION_HANDOFF_AUTHOR_NAME,
    input.isDirectMessage,
    undefined,
    {
      metadata,
      ...(input.turn
        ? {
            turnId: input.turn.turnId as TurnID,
            requestId: input.turn.requestId,
            ...(input.turn.sourceMessageId ? { sourceMessageId: input.turn.sourceMessageId } : {}),
          }
        : {}),
      channelMeta: { privacyLevel: 'private' },
    },
  );

  emittedDedupeKeys.add(handoff.dedupeKey);
  await input.eventBus.emit('agent.completion_handoff', {
    handoff,
    targetChannelId,
    ...(sessionEntryId !== null ? { sessionEntryId } : {}),
    timestamp: Date.now(),
  });
  return {
    emitted: true,
    handoff,
    targetChannelId,
    sessionEntryId,
  };
}

export function renderCompletionHandoffForContext(handoff: CompletionHandoffRecord): string {
  return [
    '[SYSTEM: CompletionHandoff]',
    'Internal structured completion handoff. This is companion-only context, not partner-authored speech and not a partner-facing notification.',
    JSON.stringify(handoff, null, 2),
  ].join('\n');
}

export function buildCompletionHandoffMetadata(handoff: CompletionHandoffRecord): string {
  return JSON.stringify({
    type: COMPLETION_HANDOFF_METADATA_TYPE,
    schemaVersion: COMPLETION_HANDOFF_SCHEMA_VERSION,
    dedupeKey: handoff.dedupeKey,
    handoffId: handoff.handoffId,
    source: handoff.source,
    status: handoff.status,
    partialResult: handoff.result.partial,
  });
}

export function extractOriginIds(value: unknown): {
  originatingTaskId?: string;
  originatingBeadId?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const originatingTaskId = firstString(
    record.originatingTaskId,
    record.taskId,
    record.actionId,
    record.continuationId,
  );
  const originatingBeadId = firstString(
    record.originatingBeadId,
    record.beadId,
    record.issueId,
  );
  return {
    ...(originatingTaskId ? { originatingTaskId } : {}),
    ...(originatingBeadId ? { originatingBeadId } : {}),
  };
}

export function safeEmitCompletionHandoffError(error: unknown): string {
  return `completion handoff failed: ${toErrorMessage(error)}`;
}

function isCompletionHandoffRecord(value: CompletionHandoffInput | CompletionHandoffRecord): value is CompletionHandoffRecord {
  return 'schemaVersion' in value;
}

function isDuplicateHandoff(
  dedupeKey: string,
  targetChannelId: string | undefined,
  readRecent: (channelId: string) => SessionEntry[],
): boolean {
  if (emittedDedupeKeys.has(dedupeKey)) {
    return true;
  }
  if (!targetChannelId) {
    return false;
  }
  return readRecent(targetChannelId).some(entry => entryHasHandoffDedupeKey(entry, dedupeKey));
}

function entryHasHandoffDedupeKey(entry: Pick<SessionEntry, 'metadata'>, dedupeKey: string): boolean {
  if (!entry.metadata) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.metadata);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const metadata = parsed as Record<string, unknown>;
  const handoff = metadata.type === COMPLETION_HANDOFF_METADATA_TYPE
    ? metadata
    : metadata.completionHandoff;
  return Boolean(
    handoff
    && typeof handoff === 'object'
    && !Array.isArray(handoff)
    && (handoff as Record<string, unknown>).dedupeKey === dedupeKey,
  );
}

function normalizeRefs(refs: readonly CompletionHandoffRef[] | undefined): CompletionHandoffRef[] {
  const normalized: CompletionHandoffRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const kind = ref.kind.trim();
    const value = ref.ref.trim();
    if (!kind || !value) {
      continue;
    }
    const key = `${kind}:${value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      kind,
      ref: value,
      ...(ref.label?.trim() ? { label: ref.label.trim() } : {}),
      ...(ref.policy?.trim() ? { policy: ref.policy.trim() } : {}),
    });
  }
  return normalized;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const text = value.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeBlocker(blocker: CompletionHandoffBlocker): CompletionHandoffBlocker {
  return {
    reason: summarizeCompletionText(blocker.reason, 'blocked'),
    ...(blocker.error ? { error: summarizeCompletionText(blocker.error, 'error') } : {}),
    ...(blocker.details ? { details: { ...blocker.details } } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}
