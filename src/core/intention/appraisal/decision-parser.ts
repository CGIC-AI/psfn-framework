import type { PendingFollowUpWakeCondition } from '../pending-follow-ups.js';
import type {
  IntentionActionDecision,
  IntentionConcernDecision,
  IntentionDecisionPriority,
  IntentionDecisionTiming,
  IntentionDecisionType,
  IntentionFollowUpDecision,
  IntentionReminderDecision,
  IntentionScheduleDecision,
  ParsedDecisionResponse,
} from './types.js';
import { normalizeConcernPriority } from './input-normalization.js';
import { isRecord, parseOptionalDueAt } from './shared.js';

function normalizePriority(value: unknown): IntentionDecisionPriority {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'medium';
}

function normalizeTiming(value: unknown): IntentionDecisionTiming {
  if (value === 'immediate' || value === 'soon' || value === 'scheduled' || value === 'none') {
    return value;
  }
  return 'soon';
}

function parseDecisionType(value: unknown): IntentionDecisionType | null {
  if (value === 'followUp' || value === 'concern' || value === 'schedule' || value === 'reminder' || value === 'noop') {
    return value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'followup':
      return 'followUp';
    case 'concern':
      return 'concern';
    case 'schedule':
      return 'schedule';
    case 'reminder':
      return 'reminder';
    case 'noop':
      return 'noop';
    default:
      return null;
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Intention appraisal response is empty');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      return body;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Intention appraisal response does not contain a JSON object');
}

function parseFollowUpPayload(value: unknown): IntentionFollowUpDecision | undefined {
  if (!isRecord(value)) return undefined;
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (!content) return undefined;
  const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
  const channelType = (
    value.channelType === 'terminal'
    || value.channelType === 'api'
    || value.channelType === 'discord'
    || value.channelType === 'telegram'
  )
    ? value.channelType
    : undefined;
  const authorId = typeof value.authorId === 'string' ? value.authorId.trim() : '';
  const authorName = typeof value.authorName === 'string' ? value.authorName.trim() : '';
  const contextSummary = typeof value.contextSummary === 'string'
    ? value.contextSummary.trim()
    : '';
  const pendingFollowUpId = typeof value.pendingFollowUpId === 'string'
    ? value.pendingFollowUpId.trim()
    : '';
  const delivery = value.delivery === 'external' || value.delivery === 'internal'
    ? value.delivery
    : undefined;
  const wakeConditions = Array.isArray(value.wakeConditions)
    ? [...new Set(
      value.wakeConditions
        .filter((condition): condition is PendingFollowUpWakeCondition => (
          condition === 'next_user_turn'
          || condition === 'background_recheck'
          || condition === 'sustained_negative_mood'
        )),
    )]
    : [];

  return {
    content,
    ...(channelId ? { channelId } : {}),
    ...(channelType ? { channelType } : {}),
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(wakeConditions.length > 0 ? { wakeConditions } : {}),
    ...(pendingFollowUpId ? { pendingFollowUpId } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

function parseConcernPayload(value: unknown): IntentionConcernDecision | undefined {
  if (!isRecord(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (!title && !summary) return undefined;
  const status = value.status === 'open' || value.status === 'pending' || value.status === 'resolved'
    ? value.status
    : undefined;
  const priority = normalizeConcernPriority(value.priority);
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(parseOptionalDueAt(value.dueAt) !== undefined ? { dueAt: parseOptionalDueAt(value.dueAt) } : {}),
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
  };
}

function parseSchedulePayload(value: unknown): IntentionScheduleDecision | undefined {
  if (!isRecord(value)) return undefined;
  const templateId = typeof value.templateId === 'string' ? value.templateId.trim() : '';
  if (!templateId) return undefined;
  const sendToDiscordOverride = typeof value.sendToDiscordOverride === 'boolean'
    ? value.sendToDiscordOverride
    : undefined;
  return {
    templateId,
    ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
  };
}

function parseReminderPayload(value: unknown): IntentionReminderDecision | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind === 'important_date' || value.kind === 'self_reminder'
    ? value.kind
    : undefined;
  const classification = (
    value.classification === 'birthday'
    || value.classification === 'anniversary'
    || value.classification === 'important_date'
    || value.classification === 'check_in'
    || value.classification === 'self_note'
  )
    ? value.classification
    : undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  const schedule = value.schedule === 'one_time' || value.schedule === 'annual'
    ? value.schedule
    : undefined;
  if (!kind || !classification || !title || !content || !schedule) {
    return undefined;
  }
  const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
  const channelType = (
    value.channelType === 'terminal'
    || value.channelType === 'api'
    || value.channelType === 'discord'
    || value.channelType === 'telegram'
  )
    ? value.channelType
    : undefined;
  const reminderId = typeof value.reminderId === 'string' ? value.reminderId.trim() : '';

  return {
    kind,
    classification,
    title,
    content,
    schedule,
    ...(channelId ? { channelId } : {}),
    ...(channelType ? { channelType } : {}),
    ...(reminderId ? { reminderId } : {}),
  };
}

export function parseDecisionResponse(raw: string, maxDecisions: number): ParsedDecisionResponse {
  const jsonObject = extractJsonObject(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObject);
  } catch (error) {
    throw new Error(`Intention appraisal response is invalid JSON: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Intention appraisal response must be a JSON object');
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('Intention appraisal response field "decisions" must be an array');
  }

  const decisions: IntentionActionDecision[] = [];
  for (const rawDecision of parsed.decisions.slice(0, maxDecisions)) {
    if (!isRecord(rawDecision)) continue;
    const type = parseDecisionType(rawDecision.type);
    if (!type) continue;

    const reason = typeof rawDecision.reason === 'string'
      ? rawDecision.reason.trim()
      : '';
    if (!reason) continue;
    const dueAt = parseOptionalDueAt(rawDecision.dueAt);

    if (type === 'followUp') {
      const followUp = parseFollowUpPayload(rawDecision.followUp);
      if (!followUp) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        followUp,
      });
      continue;
    }

    if (type === 'schedule') {
      const schedule = parseSchedulePayload(rawDecision.schedule);
      if (!schedule) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        schedule,
      });
      continue;
    }

    if (type === 'concern') {
      const concern = parseConcernPayload(rawDecision.concern);
      if (!concern) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        concern,
      });
      continue;
    }

    if (type === 'reminder') {
      const reminder = parseReminderPayload(rawDecision.reminder);
      if (!reminder) continue;
      decisions.push({
        type,
        priority: normalizePriority(rawDecision.priority),
        reason,
        timing: normalizeTiming(rawDecision.timing),
        ...(dueAt !== undefined ? { dueAt } : {}),
        reminder,
      });
      continue;
    }

    decisions.push({
      type,
      priority: normalizePriority(rawDecision.priority),
      reason,
      timing: normalizeTiming(rawDecision.timing),
      ...(dueAt !== undefined ? { dueAt } : {}),
    });
  }

  return { decisions };
}

export function buildNoopDecision(reason: string): IntentionActionDecision {
  return {
    type: 'noop',
    priority: 'low',
    reason,
    timing: 'none',
  };
}
