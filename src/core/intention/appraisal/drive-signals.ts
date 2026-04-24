import { resolveActiveTimezone } from '../../../shared/time/active-timezone.js';
import { evaluatePendingFollowUpWakeState } from '../pending-follow-ups.js';
import { isBackgroundAppraisalChannel } from './classification.js';
import { formatPromptTimestamp } from './formatting.js';
import type {
  AppraisalPersonaContext,
  AppraisalTrigger,
  NormalizedIntentionAppraisalInput,
} from './types.js';

function topDiscreteLabels(discrete: Record<string, number>, limit = 5): Record<string, number> {
  return Object.fromEntries(
    Object.entries(discrete)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit),
  );
}

export function buildAppraisalPromptPayload(input: {
  normalized: NormalizedIntentionAppraisalInput;
  trigger: AppraisalTrigger;
  turnsSinceLast: number;
  emotionalShift: number;
  persona: AppraisalPersonaContext | null;
}): Record<string, unknown> {
  const { normalized, trigger, turnsSinceLast, emotionalShift, persona } = input;
  const promptRecentMessages = normalized.recentMessages.map((message) => {
    const timestampLabel = formatPromptTimestamp(message.timestamp);
    return {
      role: message.role,
      content: message.content,
      ...(timestampLabel ? { at: timestampLabel } : {}),
    };
  });
  const promptActiveConcerns = normalized.activeConcerns.map((concern) => {
    const dueAtLabel = formatPromptTimestamp(concern.dueAt);
    return {
      ...(concern.id ? { id: concern.id } : {}),
      ...(concern.title ? { title: concern.title } : {}),
      ...(concern.summary ? { summary: concern.summary } : {}),
      ...(concern.status ? { status: concern.status } : {}),
      ...(concern.priority !== undefined ? { priority: concern.priority } : {}),
      ...(dueAtLabel ? { dueAt: dueAtLabel } : {}),
    };
  });
  const promptActiveCareReminders = normalized.activeCareReminders.map((reminder) => {
    const dueAtLabel = formatPromptTimestamp(reminder.dueAt);
    return {
      ...(reminder.id ? { id: reminder.id } : {}),
      ...(reminder.kind ? { kind: reminder.kind } : {}),
      ...(reminder.classification ? { classification: reminder.classification } : {}),
      ...(reminder.schedule ? { schedule: reminder.schedule } : {}),
      ...(reminder.provenanceSource ? { provenanceSource: reminder.provenanceSource } : {}),
      ...(reminder.title ? { title: reminder.title } : {}),
      ...(reminder.content ? { content: reminder.content } : {}),
      ...(dueAtLabel ? { dueAt: dueAtLabel } : {}),
    };
  });
  const promptRecentlyResolvedConcerns = normalized.recentlyResolvedConcerns.map((concern) => {
    const resolvedAtLabel = formatPromptTimestamp(concern.resolvedAt);
    return {
      ...(concern.id ? { id: concern.id } : {}),
      ...(concern.title ? { title: concern.title } : {}),
      ...(concern.summary ? { summary: concern.summary } : {}),
      ...(concern.status ? { status: concern.status } : {}),
      ...(concern.priority !== undefined ? { priority: concern.priority } : {}),
      ...(resolvedAtLabel ? { resolvedAt: resolvedAtLabel } : {}),
    };
  });
  const promptPendingFollowUps = (normalized.internalState?.attention.pendingFollowUps ?? []).map((followUp) => {
    const createdAtLabel = formatPromptTimestamp(Date.parse(followUp.createdAt));
    const dueAtLabel = followUp.dueAt ? formatPromptTimestamp(Date.parse(followUp.dueAt)) : undefined;
    const wakeState = evaluatePendingFollowUpWakeState(followUp, {
      now: normalized.now,
      isBackgroundTurn: isBackgroundAppraisalChannel(normalized.sessionId),
      motivationSignals: normalized.motivationSignals,
      currentMoodValence: normalized.currentEmotion?.mood.valence,
    });
    return {
      id: followUp.id,
      timing: followUp.timing,
      priority: followUp.priority,
      content: followUp.content,
      ...(followUp.contextSummary ? { contextSummary: followUp.contextSummary } : {}),
      ...(createdAtLabel ? { createdAt: createdAtLabel } : {}),
      ...(dueAtLabel ? { dueAt: dueAtLabel } : {}),
      ...(followUp.wakeConditions?.length ? { wakeConditions: followUp.wakeConditions } : {}),
      eligibleNow: wakeState.eligibleNow,
      ...(wakeState.dueAtReached ? { dueNow: true } : {}),
      ...(wakeState.matchedWakeConditions.length > 0
        ? { matchedWakeConditions: wakeState.matchedWakeConditions }
        : {}),
    };
  });

  return {
    trigger,
    sessionId: normalized.sessionId,
    turnsSinceLastAppraisal: turnsSinceLast,
    emotionalShift: Number(emotionalShift.toFixed(4)),
    internalState: normalized.internalState
      ? {
        emotional: {
          vad: normalized.internalState.emotional.vad,
          mood: normalized.internalState.emotional.mood,
          confidence: normalized.internalState.emotional.confidence,
          topDiscrete: topDiscreteLabels(normalized.internalState.emotional.discreteEmotions),
        },
        cognitive: normalized.internalState.cognitive,
        attention: {
          conversationTrajectory: normalized.internalState.attention.conversationTrajectory,
          salientEntities: normalized.internalState.attention.salientEntities,
          activeConcernCount: normalized.internalState.attention.activeConcerns.length,
          careReminderCount: normalized.internalState.attention.careReminders?.length ?? 0,
        },
        relational: normalized.internalState.relational,
      }
      : null,
    currentEmotion: normalized.currentEmotion
      ? {
        vad: normalized.currentEmotion.vad,
        mood: normalized.currentEmotion.mood,
        confidence: normalized.currentEmotion.confidence,
        topDiscrete: topDiscreteLabels(normalized.currentEmotion.discrete),
      }
      : null,
    contactEmotionalSnapshot: normalized.contactEmotionalSnapshot,
    activeConcerns: promptActiveConcerns,
    pendingFollowUps: promptPendingFollowUps,
    activeCareReminders: promptActiveCareReminders,
    recentlyResolvedConcerns: promptRecentlyResolvedConcerns,
    conversationTrajectory: normalized.conversationTrajectory,
    ...(normalized.motivationSignals.length > 0 ? { motivationSignals: normalized.motivationSignals } : {}),
    recentMessages: promptRecentMessages,
    ...(persona ? { persona } : {}),
    now: formatPromptTimestamp(normalized.now) ?? null,
    timezone: resolveActiveTimezone(),
  };
}
