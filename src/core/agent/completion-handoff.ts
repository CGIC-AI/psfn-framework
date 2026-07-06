import { createHash } from 'node:crypto';
import type { EventBus } from '../../shared/event-bus.js';
import {
  COMPLETION_HANDOFF_METADATA_TYPE,
  COMPLETION_HANDOFF_SCHEMA_VERSION,
  type CompletionHandoffBlocker,
  type CompletionHandoffEmission,
  type CompletionHandoffInput,
  type CompletionHandoffRecord,
  type CompletionHandoffRef,
} from '../../shared/contracts/completion-handoff.js';
import { buildCompletionNotice, type CompletionNoticeBuffer } from './completion-notices.js';
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

const MAX_SUMMARY_CHARS = 700;
const MAX_TRACKED_DEDUPE_KEYS = 4096;

const emittedDedupeKeys = new Set<string>();

function rememberDedupeKey(dedupeKey: string): void {
  emittedDedupeKeys.add(dedupeKey);
  if (emittedDedupeKeys.size > MAX_TRACKED_DEDUPE_KEYS) {
    const oldest = emittedDedupeKeys.values().next().value;
    if (oldest !== undefined) emittedDedupeKeys.delete(oldest);
  }
}

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

/**
 * Emit a completion handoff.
 *
 * The durable record is the `agent.completion_handoff` event-bus emission
 * (journal/telemetry). Handoffs are NEVER persisted into any session store —
 * that was the source of transcript pollution that displaced real
 * conversation. When a completion is companion-relevant, pass `notices` and a
 * `targetChannelId`: a compact two-line notice is buffered and rendered once
 * into the next turn's `background_completions` prompt block. Maintenance
 * bookkeeping must omit `notices` so nothing ever reaches companion context.
 */
export async function emitCompletionHandoff(input: {
  eventBus: EventBus;
  handoff: CompletionHandoffInput | CompletionHandoffRecord;
  targetChannelId?: string;
  notices?: CompletionNoticeBuffer;
}): Promise<CompletionHandoffEmission> {
  const handoff = isCompletionHandoffRecord(input.handoff)
    ? input.handoff
    : buildCompletionHandoff(input.handoff);
  const targetChannelId = input.targetChannelId?.trim();
  if (emittedDedupeKeys.has(handoff.dedupeKey)) {
    return { emitted: false, handoff, ...(targetChannelId ? { targetChannelId } : {}), duplicate: true };
  }

  let noticeBuffered = false;
  if (input.notices && targetChannelId) {
    input.notices.register(targetChannelId, buildCompletionNotice(handoff));
    noticeBuffered = true;
  }

  rememberDedupeKey(handoff.dedupeKey);
  await input.eventBus.emit('agent.completion_handoff', {
    handoff,
    ...(targetChannelId ? { targetChannelId } : {}),
    noticeBuffered,
    timestamp: Date.now(),
  });
  return {
    emitted: true,
    handoff,
    ...(targetChannelId ? { targetChannelId } : {}),
    noticeBuffered,
  };
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
