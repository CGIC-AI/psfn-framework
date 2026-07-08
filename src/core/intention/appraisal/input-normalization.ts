import type { EmotionalSnapshot } from '../../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import { cloneEmotionTelemetryValidation } from '../../emotion/telemetry-validation.js';
import { cloneInternalState, type InternalState } from '../../self-model/state.js';
import { normalizeConcernStatus } from '../concerns.js';
import type {
  ActiveCareReminderSnapshot,
  ActiveConcernSnapshot,
  ConversationTrajectorySnapshot,
  IntentionAppraisalInput,
  IntentionAppraisalMessage,
  IntentionDecisionPriority,
  NormalizedIntentionAppraisalInput,
} from './types.js';
import {
  isRecord,
  normalizePositiveInteger,
  parseSigned,
  parseUnit,
} from './shared.js';

function normalizeEmotionSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  if (!isRecord(snapshot)) {
    throw new Error('Emotion snapshot must be an object');
  }

  if (!isRecord(snapshot.vad)) {
    throw new Error('Emotion snapshot field "vad" must be an object');
  }
  if (!isRecord(snapshot.mood)) {
    throw new Error('Emotion snapshot field "mood" must be an object');
  }
  if (!isRecord(snapshot.discrete)) {
    throw new Error('Emotion snapshot field "discrete" must be an object');
  }

  const discrete: Record<string, number> = {};
  for (const [rawEmotion, rawScore] of Object.entries(snapshot.discrete)) {
    const emotion = rawEmotion.trim().toLowerCase();
    if (!emotion) continue;
    discrete[emotion] = parseUnit(rawScore, `emotion.discrete.${emotion}`);
  }

  return {
    vad: {
      valence: parseSigned(snapshot.vad.valence, 'emotion.vad.valence'),
      arousal: parseSigned(snapshot.vad.arousal, 'emotion.vad.arousal'),
      dominance: parseSigned(snapshot.vad.dominance, 'emotion.vad.dominance'),
    },
    mood: {
      valence: parseSigned(snapshot.mood.valence, 'emotion.mood.valence'),
      arousal: parseSigned(snapshot.mood.arousal, 'emotion.mood.arousal'),
      dominance: parseSigned(snapshot.mood.dominance, 'emotion.mood.dominance'),
    },
    discrete,
    confidence: parseUnit(snapshot.confidence, 'emotion.confidence'),
  };
}

function normalizeInternalState(value: InternalState | null | undefined): InternalState | null {
  if (value === null || value === undefined) {
    return null;
  }
  return cloneInternalState(value);
}

function emotionSnapshotFromInternalState(state: InternalState): EmotionStateSnapshot {
  return normalizeEmotionSnapshot({
    vad: { ...state.emotional.vad },
    mood: { ...state.emotional.mood },
    discrete: { ...state.emotional.discreteEmotions },
    confidence: state.emotional.confidence,
  });
}

function activeConcernsFromInternalState(state: InternalState): ActiveConcernSnapshot[] {
  return state.attention.activeConcerns.map((concern) => {
    const dueAtRaw = Date.parse(concern.expiresAt);
    return {
      id: concern.id,
      title: concern.text,
      status: concern.status,
      ...(Number.isFinite(dueAtRaw) ? { dueAt: Math.floor(dueAtRaw) } : {}),
      priority: concern.priority,
    };
  });
}

function activeCareRemindersFromInternalState(state: InternalState): ActiveCareReminderSnapshot[] {
  return (state.attention.careReminders ?? []).map((reminder) => {
    const dueAtRaw = Date.parse(reminder.dueAt);
    return {
      id: reminder.id,
      kind: reminder.kind,
      classification: reminder.classification,
      title: reminder.title,
      content: reminder.content,
      schedule: reminder.schedule,
      ...(Number.isFinite(dueAtRaw) ? { dueAt: Math.floor(dueAtRaw) } : {}),
      provenanceSource: reminder.provenanceSource,
    };
  });
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`sessionId must be a string, received ${String(value)}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('sessionId must be non-empty');
  }
  return trimmed;
}

function normalizeRole(value: unknown, index: number): IntentionAppraisalMessage['role'] {
  if (value !== 'user' && value !== 'assistant' && value !== 'system' && value !== 'tool') {
    throw new Error(`recentMessages[${index}].role is invalid`);
  }
  return value;
}

function normalizeRecentMessages(
  value: readonly IntentionAppraisalMessage[],
  maxMessageCount: number,
  maxMessageChars: number,
): IntentionAppraisalMessage[] {
  if (!Array.isArray(value)) {
    throw new Error('recentMessages must be an array');
  }

  const bounded = value.slice(-maxMessageCount);
  const normalized: IntentionAppraisalMessage[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const message = bounded[index];
    if (!isRecord(message)) {
      throw new Error(`recentMessages[${index}] must be an object`);
    }
    const role = normalizeRole(message.role, index);
    if (typeof message.content !== 'string') {
      throw new Error(`recentMessages[${index}].content must be a string`);
    }

    const content = message.content.replace(/\s+/g, ' ').trim();
    if (!content) continue;
    normalized.push({
      role,
      content: content.length > maxMessageChars
        ? `${content.slice(0, maxMessageChars - 3)}...`
        : content,
      ...(typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? { timestamp: Math.max(0, Math.floor(message.timestamp)) }
        : {}),
    });
  }

  return normalized;
}

export function normalizeConcernPriority(value: unknown): IntentionDecisionPriority | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0.67) return 'high';
    if (value >= 0.34) return 'medium';
    return 'low';
  }
  return undefined;
}

function normalizeActiveConcerns(
  value: readonly ActiveConcernSnapshot[] | undefined,
  maxConcernCount: number,
): ActiveConcernSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('activeConcerns must be an array when provided');
  }

  const normalized: ActiveConcernSnapshot[] = [];
  for (const concern of value) {
    if (!isRecord(concern)) continue;
    const id = typeof concern.id === 'string' ? concern.id.trim() : undefined;
    const title = typeof concern.title === 'string' ? concern.title.trim() : undefined;
    const summary = typeof concern.summary === 'string' ? concern.summary.trim() : undefined;
    if (!title && !summary) continue;
    const status = concern.status === undefined ? undefined : normalizeConcernStatus(concern.status);
    const dueAt = (typeof concern.dueAt === 'number' && Number.isFinite(concern.dueAt) && concern.dueAt > 0)
      ? Math.floor(concern.dueAt)
      : undefined;
    const resolvedAt = (typeof concern.resolvedAt === 'number' && Number.isFinite(concern.resolvedAt) && concern.resolvedAt > 0)
      ? Math.floor(concern.resolvedAt)
      : undefined;
    const priority = normalizeConcernPriority(concern.priority);
    normalized.push({
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      ...(priority ? { priority } : {}),
    });
  }

  return normalized.slice(0, maxConcernCount);
}

function normalizeActiveCareReminders(
  value: readonly ActiveCareReminderSnapshot[] | undefined,
  maxReminderCount: number,
): ActiveCareReminderSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('activeCareReminders must be an array when provided');
  }

  const normalized: ActiveCareReminderSnapshot[] = [];
  for (const reminder of value) {
    if (!isRecord(reminder)) continue;
    const id = typeof reminder.id === 'string' ? reminder.id.trim() : undefined;
    const title = typeof reminder.title === 'string' ? reminder.title.trim() : undefined;
    const content = typeof reminder.content === 'string' ? reminder.content.trim() : undefined;
    if (!title || !content) continue;
    const kind = reminder.kind === 'important_date' || reminder.kind === 'self_reminder'
      ? reminder.kind
      : undefined;
    const classification = (
      reminder.classification === 'birthday'
      || reminder.classification === 'anniversary'
      || reminder.classification === 'important_date'
      || reminder.classification === 'check_in'
      || reminder.classification === 'self_note'
    )
      ? reminder.classification
      : undefined;
    const schedule = reminder.schedule === 'one_time' || reminder.schedule === 'annual'
      ? reminder.schedule
      : undefined;
    const dueAt = (typeof reminder.dueAt === 'number' && Number.isFinite(reminder.dueAt) && reminder.dueAt > 0)
      ? Math.floor(reminder.dueAt)
      : undefined;
    const provenanceSource = reminder.provenanceSource === 'companion_appraisal' || reminder.provenanceSource === 'operator'
      ? reminder.provenanceSource
      : undefined;
    normalized.push({
      ...(id ? { id } : {}),
      ...(kind ? { kind } : {}),
      ...(classification ? { classification } : {}),
      title,
      content,
      ...(schedule ? { schedule } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(provenanceSource ? { provenanceSource } : {}),
    });
  }

  return normalized.slice(0, maxReminderCount);
}

function normalizeContactEmotionalSnapshot(value: EmotionalSnapshot | null | undefined): EmotionalSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('contactEmotionalSnapshot must be an object when provided');
  }

  const parseOptionalEpoch = (raw: unknown): number | undefined => (
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : undefined
  );

  return {
    baselineValence: parseSigned(value.baselineValence, 'contactEmotionalSnapshot.baselineValence'),
    moodValence: parseSigned(value.moodValence, 'contactEmotionalSnapshot.moodValence'),
    moodDrift: parseSigned(value.moodDrift, 'contactEmotionalSnapshot.moodDrift'),
    moodSamples: normalizePositiveInteger(
      typeof value.moodSamples === 'number' ? Math.max(1, Math.floor(value.moodSamples)) : 1,
      1,
      'contactEmotionalSnapshot.moodSamples',
    ),
    ...(parseOptionalEpoch(value.lastMoodUpdateEpochMs) !== undefined
      ? { lastMoodUpdateEpochMs: parseOptionalEpoch(value.lastMoodUpdateEpochMs) }
      : {}),
  };
}

function normalizeConversationTrajectory(value: ConversationTrajectorySnapshot | undefined): ConversationTrajectorySnapshot | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error('conversationTrajectory must be an object when provided');
  }

  const unresolvedTopics = Array.isArray(value.unresolvedTopics)
    ? value.unresolvedTopics
      .filter(topic => typeof topic === 'string')
      .map(topic => topic.trim())
      .filter(topic => topic.length > 0)
      .slice(0, 8)
    : undefined;
  const summary = typeof value.summary === 'string' ? value.summary.trim() : undefined;
  const turnsSinceUserReply = (
    typeof value.turnsSinceUserReply === 'number'
    && Number.isFinite(value.turnsSinceUserReply)
    && value.turnsSinceUserReply >= 0
  )
    ? Math.floor(value.turnsSinceUserReply)
    : undefined;

  return {
    ...(unresolvedTopics && unresolvedTopics.length > 0 ? { unresolvedTopics } : {}),
    ...(summary ? { summary } : {}),
    ...(turnsSinceUserReply !== undefined ? { turnsSinceUserReply } : {}),
  };
}

function normalizeTriggerOverride(value: unknown): 'motivation' | null {
  if (value === undefined || value === null) return null;
  if (value === 'motivation') return value;
  throw new Error(`triggerOverride is unsupported: ${String(value)}`);
}

function normalizeMotivationSignals(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('motivationSignals must be an array when provided');
  }

  const normalized = value
    .filter(signal => typeof signal === 'string')
    .map(signal => signal.trim().toLowerCase())
    .filter(signal => signal.length > 0);
  return [...new Set(normalized)].slice(0, 8);
}

export function normalizeInput(
  input: IntentionAppraisalInput,
  options: {
    recentMessageCount: number;
    maxMessageChars: number;
    maxConcernCount: number;
  },
): NormalizedIntentionAppraisalInput {
  const sessionId = normalizeSessionId(input.sessionId);
  const internalState = normalizeInternalState(input.internalState);
  const currentEmotion = internalState
    ? emotionSnapshotFromInternalState(internalState)
    : input.currentEmotion
      ? normalizeEmotionSnapshot(input.currentEmotion)
      : null;
  const currentEmotionTelemetry = internalState?.emotional.telemetry
    ? cloneEmotionTelemetryValidation(internalState.emotional.telemetry, 'internalState.emotional.telemetry')
    : null;
  const recentMessages = normalizeRecentMessages(
    input.recentMessages,
    options.recentMessageCount,
    options.maxMessageChars,
  );
  const activeConcerns = normalizeActiveConcerns(
    input.activeConcerns ?? (internalState ? activeConcernsFromInternalState(internalState) : undefined),
    options.maxConcernCount,
  );
  const activeCareReminders = normalizeActiveCareReminders(
    input.activeCareReminders ?? (internalState ? activeCareRemindersFromInternalState(internalState) : undefined),
    options.maxConcernCount,
  );
  const recentlyResolvedConcerns = normalizeActiveConcerns(
    input.recentlyResolvedConcerns,
    options.maxConcernCount,
  );
  const contactEmotionalSnapshot = normalizeContactEmotionalSnapshot(input.contactEmotionalSnapshot);
  const conversationTrajectory = normalizeConversationTrajectory(input.conversationTrajectory);
  const triggerOverride = normalizeTriggerOverride(input.triggerOverride);
  const motivationSignals = normalizeMotivationSignals(input.motivationSignals);
  const now = (
    typeof input.now === 'number'
    && Number.isFinite(input.now)
    && input.now > 0
  )
    ? Math.floor(input.now)
    : Date.now();

  return {
    sessionId,
    internalState,
    currentEmotion,
    currentEmotionTelemetry,
    recentMessages,
    activeConcerns,
    activeCareReminders,
    recentlyResolvedConcerns,
    contactEmotionalSnapshot,
    conversationTrajectory,
    triggerOverride,
    motivationSignals,
    now,
  };
}
