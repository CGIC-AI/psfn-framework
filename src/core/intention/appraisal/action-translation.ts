import { createHash } from 'node:crypto';
import {
  CHANNEL_TYPES,
  type ChannelType,
  type InferredPostTurnAction,
  type PostTurnActionCandidate,
  type SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { PendingFollowUp } from '../pending-follow-ups.js';
import { resolveConsolidatedReflectionTemplateId } from '../../scheduler/heartbeat-policy.js';
import { evaluateProactiveOutboundTimeGate } from '../proactive-time-gate.js';
import {
  DEFAULT_FOLLOW_UP_PENDING_DELAY_MS,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  INTENTION_FOLLOW_UP_AUTHOR_ID,
  INTENTION_FOLLOW_UP_AUTHOR_NAME,
  INTENTION_REMINDER_ACTION_KIND,
  type IntentionActionDecision,
  type IntentionDecisionActionContext,
  type IntentionDecisionActionOptions,
  type IntentionFollowUpActionPayload,
  type IntentionOutboundMessageActionPayload,
  type IntentionReminderActionPayload,
} from './types.js';
import {
  hashString,
  isRecord,
  normalizeActionRunAt,
  stableStringify,
} from './shared.js';

function resolveFollowUpRunAt(
  decision: IntentionActionDecision,
  now: number,
  options: IntentionDecisionActionOptions = {},
): number | undefined {
  const runAt = normalizeActionRunAt(decision.dueAt);
  if (decision.timing === 'immediate') {
    return runAt ?? now;
  }

  if (decision.timing === 'soon') {
    if (runAt !== undefined) {
      return Math.max(now, runAt);
    }
    if (options.surfacePendingFollowUpsImmediately) {
      return now;
    }
    return now + DEFAULT_FOLLOW_UP_PENDING_DELAY_MS;
  }

  if (decision.timing === 'scheduled') {
    if (runAt !== undefined) {
      return Math.max(now, runAt);
    }
    if (options.surfacePendingFollowUpsImmediately) {
      return now;
    }
    return now + DEFAULT_FOLLOW_UP_PENDING_DELAY_MS;
  }

  return undefined;
}

function resolveReminderRunAt(
  decision: IntentionActionDecision,
  now: number,
): number | undefined {
  const runAt = normalizeActionRunAt(decision.dueAt);
  if (runAt !== undefined) {
    return Math.max(now, runAt);
  }
  if (decision.timing === 'immediate') {
    return now;
  }
  if (decision.timing === 'soon' || decision.timing === 'scheduled') {
    return now + DEFAULT_FOLLOW_UP_PENDING_DELAY_MS;
  }
  return undefined;
}

function normalizeOutboundMinimumRunAt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveOutboundRunAt(
  requestedRunAt: number | undefined,
  now: number,
  options: IntentionDecisionActionOptions,
): number | undefined {
  const minimumOutboundRunAt = normalizeOutboundMinimumRunAt(options.minimumOutboundRunAt);
  const earliestSendAtMs = Math.max(
    now,
    requestedRunAt ?? now,
    minimumOutboundRunAt ?? now,
  );
  const gate = evaluateProactiveOutboundTimeGate({
    nowMs: now,
    earliestSendAtMs,
    quietHours: options.proactiveOutboundQuietHours,
  });
  return gate.allowed ? earliestSendAtMs : gate.nextEligibleAtMs;
}

function normalizeCandidatePayload(payload: PostTurnActionCandidate['payload']): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const normalizedEntries = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalizedEntries);
}

function normalizeConcernIds(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized && !ids.includes(normalized)) {
      ids.push(normalized);
    }
  }
  return ids;
}

export function decisionsToPostTurnActionCandidates(
  decisions: readonly IntentionActionDecision[],
  context: IntentionDecisionActionContext,
  options: IntentionDecisionActionOptions = {},
): PostTurnActionCandidate[] {
  const candidates: PostTurnActionCandidate[] = [];
  const now = options.now ?? Date.now();

  for (const decision of decisions) {
    if (decision.type === 'followUp') {
      const content = decision.followUp?.content.trim() ?? '';
      if (!content) continue;
      const hasStateWakeConditions = Array.isArray(decision.followUp?.wakeConditions)
        && decision.followUp.wakeConditions.length > 0;
      if (hasStateWakeConditions && decision.dueAt === undefined && decision.timing !== 'immediate') {
        continue;
      }
      const runAt = resolveFollowUpRunAt(decision, now, options);
      const channelId = decision.followUp?.channelId?.trim() || context.message.channelId;
      const channelType = decision.followUp?.channelType ?? context.message.channelType;
      if (decision.followUp?.delivery === 'external') {
        const outboundRunAt = resolveOutboundRunAt(runAt, now, options);
        const concernIds = normalizeConcernIds(decision.followUp.concernIds);
        candidates.push({
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          dedupeKey: `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:${context.message.id}:${hashString(content)}`,
          payload: {
            channelId,
            channelType,
            content,
            reason: decision.reason,
            ...(decision.followUp.pendingFollowUpId
              ? { pendingFollowUpId: decision.followUp.pendingFollowUpId }
              : {}),
            ...(concernIds.length > 0 ? { concernIds } : {}),
            ...(decision.followUp.requiresActiveConcern === true
              ? { requiresActiveConcern: true }
              : {}),
          } satisfies IntentionOutboundMessageActionPayload,
          maxRetries: 1,
          ...(outboundRunAt !== undefined ? { runAt: outboundRunAt } : {}),
        });
        continue;
      }
      const dedupeKey = `${INTENTION_FOLLOW_UP_ACTION_KIND}:${context.message.id}:${hashString(content)}`;
      candidates.push({
        kind: INTENTION_FOLLOW_UP_ACTION_KIND,
        dedupeKey,
        payload: {
          channelId,
          channelType,
          authorId: INTENTION_FOLLOW_UP_AUTHOR_ID,
          authorName: INTENTION_FOLLOW_UP_AUTHOR_NAME,
          content,
          ...(decision.followUp?.pendingFollowUpId
            ? { pendingFollowUpId: decision.followUp.pendingFollowUpId }
            : {}),
        } satisfies IntentionFollowUpActionPayload,
        maxRetries: 1,
        ...(runAt !== undefined ? { runAt } : {}),
      });
      continue;
    }

    if (decision.type === 'schedule') {
      const templateId = resolveConsolidatedReflectionTemplateId(decision.schedule?.templateId ?? '');
      if (!templateId) continue;
      candidates.push({
        kind: 'heartbeat.run_template',
        dedupeKey: `heartbeat.run_template:${templateId}:${context.message.id}`,
        payload: {
          templateId,
          ...(decision.schedule?.sendToDiscordOverride !== undefined
            ? { sendToDiscordOverride: decision.schedule.sendToDiscordOverride }
            : {}),
        },
        maxRetries: 2,
      });
      continue;
    }

    if (decision.type === 'reminder') {
      const reminderId = decision.reminder?.reminderId?.trim() ?? '';
      if (!reminderId) continue;
      const runAt = resolveReminderRunAt(decision, now);
      const dedupeSuffix = typeof runAt === 'number' && Number.isFinite(runAt)
        ? String(runAt)
        : 'unscheduled';
      candidates.push({
        kind: INTENTION_REMINDER_ACTION_KIND,
        dedupeKey: `${INTENTION_REMINDER_ACTION_KIND}:${reminderId}:${dedupeSuffix}`,
        payload: {
          reminderId,
        } satisfies IntentionReminderActionPayload,
        maxRetries: 1,
        ...(runAt !== undefined ? { runAt } : {}),
      });
    }
  }

  return candidates;
}

export function pendingFollowUpsToPostTurnActionCandidates(
  followUps: readonly PendingFollowUp[],
): PostTurnActionCandidate[] {
  const candidates: PostTurnActionCandidate[] = [];
  for (const followUp of followUps) {
    const content = followUp.content.trim();
    if (!content) {
      continue;
    }
    candidates.push({
      kind: INTENTION_FOLLOW_UP_ACTION_KIND,
      dedupeKey: `${INTENTION_FOLLOW_UP_ACTION_KIND}:pending:${followUp.id}`,
      payload: {
        channelId: followUp.channelId,
        channelType: followUp.channelType,
        authorId: followUp.authorId,
        authorName: followUp.authorName,
        content,
        pendingFollowUpId: followUp.id,
      } satisfies IntentionFollowUpActionPayload,
      maxRetries: 1,
    });
  }
  return candidates;
}

export function normalizeIntentionFollowUpActionPayload(payload: unknown): IntentionFollowUpActionPayload | null {
  if (!isRecord(payload)) return null;
  const channelId = typeof payload.channelId === 'string' ? payload.channelId.trim() : '';
  const authorId = typeof payload.authorId === 'string' ? payload.authorId.trim() : '';
  const authorName = typeof payload.authorName === 'string' ? payload.authorName.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const pendingFollowUpId = typeof payload.pendingFollowUpId === 'string'
    ? payload.pendingFollowUpId.trim()
    : '';
  const channelType = payload.channelType;
  if (!channelId || !authorId || !authorName || !content) return null;
  if (typeof channelType !== 'string' || !CHANNEL_TYPES.includes(channelType as ChannelType)) {
    return null;
  }

  return {
    channelId,
    channelType: channelType as ChannelType,
    authorId,
    authorName,
    content,
    ...(pendingFollowUpId ? { pendingFollowUpId } : {}),
  };
}

export function normalizeIntentionOutboundMessageActionPayload(
  payload: unknown,
): IntentionOutboundMessageActionPayload | null {
  if (!isRecord(payload)) return null;
  const channelId = typeof payload.channelId === 'string' ? payload.channelId.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  const pendingFollowUpId = typeof payload.pendingFollowUpId === 'string'
    ? payload.pendingFollowUpId.trim()
    : '';
  const concernIds = Array.isArray(payload.concernIds)
    ? normalizeConcernIds(payload.concernIds.filter((id): id is string => typeof id === 'string'))
    : [];
  const requiresActiveConcern = payload.requiresActiveConcern === true;
  const channelType = payload.channelType;
  if (!channelId || !content) return null;
  if (typeof channelType !== 'string' || !CHANNEL_TYPES.includes(channelType as ChannelType)) {
    return null;
  }
  return {
    channelId,
    channelType: channelType as ChannelType,
    content,
    ...(reason ? { reason } : {}),
    ...(pendingFollowUpId ? { pendingFollowUpId } : {}),
    ...(concernIds.length > 0 ? { concernIds } : {}),
    ...(requiresActiveConcern ? { requiresActiveConcern } : {}),
  };
}

export function normalizeIntentionReminderActionPayload(payload: unknown): IntentionReminderActionPayload | null {
  if (!isRecord(payload)) return null;
  const reminderId = typeof payload.reminderId === 'string' ? payload.reminderId.trim() : '';
  if (!reminderId) {
    return null;
  }
  return { reminderId };
}

export function toInferredPostTurnActions(
  candidates: readonly PostTurnActionCandidate[],
  message: Pick<SubstrateMessage, 'id' | 'channelId'>,
): InferredPostTurnAction[] {
  const inferred: InferredPostTurnAction[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const [ordinal, candidate] of candidates.entries()) {
    if (typeof candidate.kind !== 'string') continue;
    const kind = candidate.kind.trim();
    if (!kind) continue;
    const payload = normalizeCandidatePayload(candidate.payload);
    const explicitDedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
    const dedupeKey = explicitDedupeKey
      || `${kind}:${message.channelId}:${hashString(stableStringify(payload))}`;
    if (seenDedupeKeys.has(dedupeKey)) continue;
    seenDedupeKeys.add(dedupeKey);

    const id = createHash('sha256')
      .update(`${message.id}:${kind}:${dedupeKey}:${ordinal}`)
      .digest('hex')
      .slice(0, 24);
    const maxRetries = (
      typeof candidate.maxRetries === 'number'
      && Number.isFinite(candidate.maxRetries)
      && candidate.maxRetries >= 0
    )
      ? Math.floor(candidate.maxRetries)
      : undefined;
    const runAt = normalizeActionRunAt(candidate.runAt);

    inferred.push({
      id,
      kind,
      payload,
      dedupeKey,
      channelId: message.channelId,
      sourceMessageId: message.id,
      inferredAt: Date.now(),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(runAt !== undefined ? { runAt } : {}),
    });
  }

  return inferred;
}
