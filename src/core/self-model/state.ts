import { createHash } from 'node:crypto';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { EmotionStateSnapshot, VADVector } from '../emotion/state.js';
import {
  ACTIVE_CONCERN_PRIORITIES,
  ACTIVE_CONCERN_SOURCES,
  type ActiveConcern,
  type ActiveConcernPriority,
} from '../intention/concerns.js';
import {
  PENDING_FOLLOW_UP_PRIORITIES,
  PENDING_FOLLOW_UP_TIMINGS,
  type PendingFollowUp,
  type PendingFollowUpPriority,
  type PendingFollowUpTiming,
} from '../intention/pending-follow-ups.js';
import { TRUST_LEVELS, type TrustLevel } from '../../trust/types.js';

export const INTERNAL_STATE_PROCESSING_QUALITIES = ['fluent', 'deliberate', 'struggling'] as const;
export type InternalStateProcessingQuality = typeof INTERNAL_STATE_PROCESSING_QUALITIES[number];

export const INTERNAL_STATE_CONVERSATION_TRAJECTORIES = ['deepening', 'shifting', 'wrapping-up', 'casual'] as const;
export type InternalStateConversationTrajectory = typeof INTERNAL_STATE_CONVERSATION_TRAJECTORIES[number];

export interface InternalState {
  emotional: {
    vad: VADVector;
    mood: VADVector;
    discreteEmotions: Record<string, number>;
    confidence: number;
  };
  cognitive: {
    certaintyLevel: number;
    topicEngagement: number;
    processingQuality: InternalStateProcessingQuality;
  };
  attention: {
    activeConcerns: ActiveConcern[];
    pendingFollowUps?: PendingFollowUp[];
    salientEntities: string[];
    conversationTrajectory: InternalStateConversationTrajectory;
  };
  relational: {
    contactId: string | null;
    trustLevel: TrustLevel;
    baselineValence: number;
    moodDrift: number;
    recentInteractionFrequency: number;
    lastSeenDeltaSeconds: number | null;
  };
}

export interface InternalStateSessionMetrics {
  userMessageText: string;
  responseText: string;
  toolCallCount: number;
  recentTurnCount: number;
  lastSeenDeltaSeconds?: number | null;
}

export interface InternalStateComputeInput {
  emotionState: EmotionStateSnapshot;
  activeConcerns: readonly ActiveConcern[];
  pendingFollowUps?: readonly PendingFollowUp[];
  trustLevel: TrustLevel;
  contactId?: string;
  contactEmotionalSnapshot?: EmotionalSnapshot | null;
  sessionMetrics: InternalStateSessionMetrics;
}

interface NormalizedInternalStateComputeInput {
  emotionState: EmotionStateSnapshot;
  activeConcerns: ActiveConcern[];
  pendingFollowUps: PendingFollowUp[];
  trustLevel: TrustLevel;
  contactId: string | null;
  contactEmotionalSnapshot: EmotionalSnapshot | null;
  sessionMetrics: {
    userMessageText: string;
    responseText: string;
    toolCallCount: number;
    recentTurnCount: number;
    lastSeenDeltaSeconds: number | null;
  };
}

const WRAPPING_UP_MARKERS = [
  'bye',
  'goodbye',
  'talk later',
  'see you',
  'good night',
  'thanks, thats all',
  "that's all",
  'done for now',
] as const;

const SHIFTING_MARKERS = [
  'anyway',
  'by the way',
  'switching gears',
  'different topic',
  'new topic',
  'unrelated',
  'on another note',
] as const;

const PRIORITY_RANK: Record<ActiveConcernPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const ENTITY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'us',
  'we',
  'what',
  'when',
  'where',
  'who',
  'why',
  'you',
  'your',
]);

const TOKEN_PATTERN = /[a-z0-9][a-z0-9'_-]*/g;
const MAX_SALIENT_ENTITIES = 8;
const MAX_SALIENT_ENTITY_LENGTH = 48;

export const INTERNAL_STATE_NEUTRAL_EMOTION: EmotionStateSnapshot = Object.freeze({
  vad: Object.freeze({ valence: 0, arousal: 0, dominance: 0 }),
  mood: Object.freeze({ valence: 0, arousal: 0, dominance: 0 }),
  discrete: Object.freeze({}),
  confidence: 0,
});

export class InternalStateComputer {
  computeState(input: InternalStateComputeInput): InternalState {
    const normalized = normalizeComputeInput(input);
    const certaintyLevel = resolveCertaintyLevel(
      normalized.emotionState,
      normalized.sessionMetrics.userMessageText,
      normalized.sessionMetrics.responseText,
    );
    const topicEngagement = resolveTopicEngagement(
      normalized.emotionState.vad.arousal,
      normalized.sessionMetrics.userMessageText,
      normalized.sessionMetrics.responseText,
      normalized.sessionMetrics.toolCallCount,
    );

    return {
      emotional: {
        vad: { ...normalized.emotionState.vad },
        mood: { ...normalized.emotionState.mood },
        discreteEmotions: { ...normalized.emotionState.discrete },
        confidence: normalized.emotionState.confidence,
      },
      cognitive: {
        certaintyLevel,
        topicEngagement,
        processingQuality: resolveProcessingQuality(
          certaintyLevel,
          normalized.sessionMetrics.responseText,
          normalized.sessionMetrics.toolCallCount,
        ),
      },
      attention: {
        activeConcerns: normalized.activeConcerns,
        pendingFollowUps: normalized.pendingFollowUps,
        salientEntities: resolveSalientEntities(
          normalized.sessionMetrics.userMessageText,
          normalized.sessionMetrics.responseText,
          normalized.activeConcerns,
        ),
        conversationTrajectory: resolveConversationTrajectory(
          normalized.sessionMetrics.userMessageText,
          normalized.sessionMetrics.responseText,
          normalized.activeConcerns.length,
        ),
      },
      relational: {
        contactId: normalized.contactId,
        trustLevel: normalized.trustLevel,
        baselineValence: normalized.contactEmotionalSnapshot?.baselineValence ?? 0,
        moodDrift: normalized.contactEmotionalSnapshot?.moodDrift ?? 0,
        recentInteractionFrequency: roundDecimal(
          clampUnit(normalized.sessionMetrics.recentTurnCount / 12),
        ),
        lastSeenDeltaSeconds: normalized.sessionMetrics.lastSeenDeltaSeconds,
      },
    };
  }
}

export function cloneInternalState(state: InternalState): InternalState {
  return normalizeInternalState(state);
}

export function serializeInternalState(state: InternalState): string {
  return JSON.stringify(normalizeInternalState(state));
}

export function buildInternalStateSnapshotRef(state: InternalState): string {
  const serialized = serializeInternalState(state);
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  return `internal-state-v1:${digest}`;
}

function normalizeComputeInput(input: InternalStateComputeInput): NormalizedInternalStateComputeInput {
  if (!isRecord(input)) {
    throw new Error('InternalState compute input must be an object');
  }
  return {
    emotionState: normalizeEmotionStateSnapshot(input.emotionState),
    activeConcerns: normalizeActiveConcerns(input.activeConcerns),
    pendingFollowUps: normalizePendingFollowUps(input.pendingFollowUps ?? []),
    trustLevel: normalizeTrustLevel(input.trustLevel),
    contactId: normalizeOptionalIdentifier(input.contactId, 'contactId'),
    contactEmotionalSnapshot: normalizeOptionalEmotionalSnapshot(input.contactEmotionalSnapshot),
    sessionMetrics: normalizeSessionMetrics(input.sessionMetrics),
  };
}

function normalizeSessionMetrics(
  value: InternalStateSessionMetrics,
): NormalizedInternalStateComputeInput['sessionMetrics'] {
  if (!isRecord(value)) {
    throw new Error('InternalState sessionMetrics must be an object');
  }
  const toolCallCount = parseNonNegativeFinite(value.toolCallCount, 'sessionMetrics.toolCallCount');
  const recentTurnCount = parseNonNegativeFinite(value.recentTurnCount, 'sessionMetrics.recentTurnCount');
  const lastSeenDeltaSeconds = value.lastSeenDeltaSeconds === undefined || value.lastSeenDeltaSeconds === null
    ? null
    : parseNonNegativeFinite(value.lastSeenDeltaSeconds, 'sessionMetrics.lastSeenDeltaSeconds');

  return {
    userMessageText: normalizeText(value.userMessageText, 'sessionMetrics.userMessageText'),
    responseText: normalizeText(value.responseText, 'sessionMetrics.responseText'),
    toolCallCount: Math.floor(toolCallCount),
    recentTurnCount: Math.floor(recentTurnCount),
    lastSeenDeltaSeconds: lastSeenDeltaSeconds === null ? null : roundDecimal(lastSeenDeltaSeconds),
  };
}

function normalizeEmotionStateSnapshot(snapshot: EmotionStateSnapshot): EmotionStateSnapshot {
  if (!isRecord(snapshot)) {
    throw new Error('InternalState emotionState must be an object');
  }
  if (!isRecord(snapshot.vad)) {
    throw new Error('InternalState emotionState.vad must be an object');
  }
  if (!isRecord(snapshot.mood)) {
    throw new Error('InternalState emotionState.mood must be an object');
  }
  if (!isRecord(snapshot.discrete)) {
    throw new Error('InternalState emotionState.discrete must be an object');
  }

  const discreteEntries = Object.entries(snapshot.discrete)
    .map(([rawEmotion, rawScore]) => {
      const emotion = rawEmotion.trim().toLowerCase();
      if (!emotion) return null;
      return [emotion, parseUnit(rawScore, `emotionState.discrete.${emotion}`)] as const;
    })
    .filter((entry): entry is readonly [string, number] => entry !== null)
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    vad: {
      valence: parseSigned(snapshot.vad.valence, 'emotionState.vad.valence'),
      arousal: parseSigned(snapshot.vad.arousal, 'emotionState.vad.arousal'),
      dominance: parseSigned(snapshot.vad.dominance, 'emotionState.vad.dominance'),
    },
    mood: {
      valence: parseSigned(snapshot.mood.valence, 'emotionState.mood.valence'),
      arousal: parseSigned(snapshot.mood.arousal, 'emotionState.mood.arousal'),
      dominance: parseSigned(snapshot.mood.dominance, 'emotionState.mood.dominance'),
    },
    discrete: Object.fromEntries(discreteEntries),
    confidence: parseUnit(snapshot.confidence, 'emotionState.confidence'),
  };
}

function normalizeActiveConcerns(value: readonly ActiveConcern[]): ActiveConcern[] {
  if (!Array.isArray(value)) {
    throw new Error('InternalState activeConcerns must be an array');
  }
  return value
    .map((concern, index) => normalizeConcern(concern, index))
    .sort(compareConcerns);
}

function normalizePendingFollowUps(value: readonly PendingFollowUp[]): PendingFollowUp[] {
  if (!Array.isArray(value)) {
    throw new Error('InternalState pendingFollowUps must be an array');
  }
  return value
    .map((followUp, index) => normalizePendingFollowUp(followUp, index))
    .sort(comparePendingFollowUps);
}

function normalizeConcern(concern: ActiveConcern, index: number): ActiveConcern {
  if (!isRecord(concern)) {
    throw new Error(`InternalState activeConcern[${String(index)}] must be an object`);
  }
  const prefix = `activeConcern[${String(index)}]`;
  const priority = normalizeConcernPriority(concern.priority, `${prefix}.priority`);
  const source = normalizeConcernSource(concern.source, `${prefix}.source`);
  const createdAt = normalizeIsoTimestamp(concern.createdAt, `${prefix}.createdAt`);
  const expiresAt = normalizeIsoTimestamp(concern.expiresAt, `${prefix}.expiresAt`);
  const resolvedAt = concern.resolvedAt === undefined
    ? undefined
    : normalizeIsoTimestamp(concern.resolvedAt, `${prefix}.resolvedAt`);
  const resolutionOutcome = concern.resolutionOutcome === undefined
    ? undefined
    : normalizeOptionalText(concern.resolutionOutcome, `${prefix}.resolutionOutcome`);
  const contactId = concern.contactId === undefined
    ? undefined
    : normalizeOptionalIdentifier(concern.contactId, `${prefix}.contactId`) ?? undefined;
  const formationVAD = concern.formationVAD === undefined
    ? undefined
    : normalizeFormationVAD(concern.formationVAD, `${prefix}.formationVAD`);

  return {
    id: normalizeIdentifier(concern.id, `${prefix}.id`),
    text: normalizeText(concern.text, `${prefix}.text`),
    priority,
    source,
    createdAt,
    expiresAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionOutcome ? { resolutionOutcome } : {}),
    ...(contactId ? { contactId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
  };
}

function normalizePendingFollowUp(followUp: PendingFollowUp, index: number): PendingFollowUp {
  if (!isRecord(followUp)) {
    throw new Error(`InternalState pendingFollowUp[${String(index)}] must be an object`);
  }
  const prefix = `pendingFollowUp[${String(index)}]`;
  const priority = normalizePendingFollowUpPriority(followUp.priority, `${prefix}.priority`);
  const timing = normalizePendingFollowUpTiming(followUp.timing, `${prefix}.timing`);
  const createdAt = normalizeIsoTimestamp(followUp.createdAt, `${prefix}.createdAt`);
  const dueAt = followUp.dueAt === undefined
    ? undefined
    : normalizeIsoTimestamp(followUp.dueAt, `${prefix}.dueAt`);
  const contactId = followUp.contactId === undefined
    ? undefined
    : normalizeOptionalIdentifier(followUp.contactId, `${prefix}.contactId`) ?? undefined;
  const sourceMessageId = followUp.sourceMessageId === undefined
    ? undefined
    : normalizeOptionalIdentifier(followUp.sourceMessageId, `${prefix}.sourceMessageId`) ?? undefined;
  const activatedAt = followUp.activatedAt === undefined
    ? undefined
    : normalizeIsoTimestamp(followUp.activatedAt, `${prefix}.activatedAt`);
  const activationReason = followUp.activationReason === undefined
    ? undefined
    : normalizeOptionalText(followUp.activationReason, `${prefix}.activationReason`);

  return {
    id: normalizeIdentifier(followUp.id, `${prefix}.id`),
    content: normalizeText(followUp.content, `${prefix}.content`),
    priority,
    timing,
    createdAt,
    channelId: normalizeIdentifier(followUp.channelId, `${prefix}.channelId`),
    channelType: normalizePendingFollowUpChannelType(followUp.channelType, `${prefix}.channelType`),
    authorId: normalizeIdentifier(followUp.authorId, `${prefix}.authorId`),
    authorName: normalizeText(followUp.authorName, `${prefix}.authorName`),
    ...(dueAt ? { dueAt } : {}),
    ...(contactId ? { contactId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(activatedAt ? { activatedAt } : {}),
    ...(activationReason ? { activationReason } : {}),
  };
}

function normalizeFormationVAD(value: ActiveConcern['formationVAD'], fieldName: string) {
  if (!value || !isRecord(value)) {
    throw new Error(`InternalState field "${fieldName}" must be an object`);
  }
  return {
    valence: parseSigned(value.valence, `${fieldName}.valence`),
    arousal: parseSigned(value.arousal, `${fieldName}.arousal`),
    dominance: parseSigned(value.dominance, `${fieldName}.dominance`),
  };
}

function normalizeConcernPriority(value: string, fieldName: string): ActiveConcernPriority {
  if (!ACTIVE_CONCERN_PRIORITIES.includes(value as ActiveConcernPriority)) {
    throw new Error(`InternalState field "${fieldName}" has unsupported priority "${String(value)}"`);
  }
  return value as ActiveConcernPriority;
}

function normalizeConcernSource(value: string, fieldName: string): ActiveConcern['source'] {
  if (!ACTIVE_CONCERN_SOURCES.includes(value as ActiveConcern['source'])) {
    throw new Error(`InternalState field "${fieldName}" has unsupported source "${String(value)}"`);
  }
  return value as ActiveConcern['source'];
}

function normalizePendingFollowUpPriority(value: string, fieldName: string): PendingFollowUpPriority {
  if (!PENDING_FOLLOW_UP_PRIORITIES.includes(value as PendingFollowUpPriority)) {
    throw new Error(`InternalState field "${fieldName}" has unsupported priority "${String(value)}"`);
  }
  return value as PendingFollowUpPriority;
}

function normalizePendingFollowUpTiming(value: string, fieldName: string): PendingFollowUpTiming {
  if (!PENDING_FOLLOW_UP_TIMINGS.includes(value as PendingFollowUpTiming)) {
    throw new Error(`InternalState field "${fieldName}" has unsupported timing "${String(value)}"`);
  }
  return value as PendingFollowUpTiming;
}

function normalizePendingFollowUpChannelType(
  value: string,
  fieldName: string,
): PendingFollowUp['channelType'] {
  if (
    value !== 'terminal'
    && value !== 'api'
    && value !== 'discord'
    && value !== 'telegram'
    && value !== 'psfn-amica'
  ) {
    throw new Error(`InternalState field "${fieldName}" has unsupported channelType "${String(value)}"`);
  }
  return value;
}

function compareConcerns(left: ActiveConcern, right: ActiveConcern): number {
  const priorityDelta = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priorityDelta !== 0) return priorityDelta;
  const expiresAtDelta = Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
  if (expiresAtDelta !== 0) return expiresAtDelta;
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) return createdAtDelta;
  return left.id.localeCompare(right.id);
}

function comparePendingFollowUps(left: PendingFollowUp, right: PendingFollowUp): number {
  const dueAtDelta = Date.parse(left.dueAt ?? left.createdAt) - Date.parse(right.dueAt ?? right.createdAt);
  if (dueAtDelta !== 0) return dueAtDelta;
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) return createdAtDelta;
  return left.id.localeCompare(right.id);
}

function normalizeOptionalEmotionalSnapshot(
  value: EmotionalSnapshot | null | undefined,
): EmotionalSnapshot | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error('InternalState contactEmotionalSnapshot must be an object when provided');
  }

  return {
    baselineValence: parseSigned(value.baselineValence, 'contactEmotionalSnapshot.baselineValence'),
    moodValence: parseSigned(value.moodValence, 'contactEmotionalSnapshot.moodValence'),
    moodDrift: parseSigned(value.moodDrift, 'contactEmotionalSnapshot.moodDrift'),
    moodSamples: parseNonNegativeFinite(value.moodSamples, 'contactEmotionalSnapshot.moodSamples'),
    ...(value.lastMoodUpdateEpochMs !== undefined
      ? {
        lastMoodUpdateEpochMs: parseNonNegativeFinite(
          value.lastMoodUpdateEpochMs,
          'contactEmotionalSnapshot.lastMoodUpdateEpochMs',
        ),
      }
      : {}),
  };
}

function normalizeTrustLevel(value: TrustLevel): TrustLevel {
  if (!TRUST_LEVELS.includes(value)) {
    throw new Error(`InternalState trustLevel "${String(value)}" is unsupported`);
  }
  return value;
}

function normalizeInternalState(state: InternalState): InternalState {
  if (!isRecord(state)) {
    throw new Error('InternalState must be an object');
  }
  if (!isRecord(state.emotional)) {
    throw new Error('InternalState emotional field must be an object');
  }
  if (!isRecord(state.cognitive)) {
    throw new Error('InternalState cognitive field must be an object');
  }
  if (!isRecord(state.attention)) {
    throw new Error('InternalState attention field must be an object');
  }
  if (!isRecord(state.relational)) {
    throw new Error('InternalState relational field must be an object');
  }

  return {
      emotional: {
        vad: {
          valence: parseSigned(state.emotional.vad.valence, 'emotional.vad.valence'),
          arousal: parseSigned(state.emotional.vad.arousal, 'emotional.vad.arousal'),
          dominance: parseSigned(state.emotional.vad.dominance, 'emotional.vad.dominance'),
        },
        mood: {
          valence: parseSigned(state.emotional.mood.valence, 'emotional.mood.valence'),
          arousal: parseSigned(state.emotional.mood.arousal, 'emotional.mood.arousal'),
          dominance: parseSigned(state.emotional.mood.dominance, 'emotional.mood.dominance'),
        },
      discreteEmotions: normalizeDiscreteEmotions(state.emotional.discreteEmotions),
      confidence: parseUnit(state.emotional.confidence, 'emotional.confidence'),
    },
    cognitive: {
      certaintyLevel: parseUnit(state.cognitive.certaintyLevel, 'cognitive.certaintyLevel'),
      topicEngagement: parseUnit(state.cognitive.topicEngagement, 'cognitive.topicEngagement'),
      processingQuality: normalizeProcessingQuality(state.cognitive.processingQuality),
    },
    attention: {
      activeConcerns: normalizeActiveConcerns(state.attention.activeConcerns),
      pendingFollowUps: normalizePendingFollowUps(state.attention.pendingFollowUps ?? []),
      salientEntities: normalizeSalientEntities(state.attention.salientEntities),
      conversationTrajectory: normalizeConversationTrajectory(state.attention.conversationTrajectory),
    },
    relational: {
      contactId: normalizeOptionalIdentifier(state.relational.contactId, 'relational.contactId'),
      trustLevel: normalizeTrustLevel(state.relational.trustLevel),
      baselineValence: parseSigned(state.relational.baselineValence, 'relational.baselineValence'),
      moodDrift: parseSigned(state.relational.moodDrift, 'relational.moodDrift'),
      recentInteractionFrequency: parseUnit(
        state.relational.recentInteractionFrequency,
        'relational.recentInteractionFrequency',
      ),
      lastSeenDeltaSeconds: state.relational.lastSeenDeltaSeconds === null
        ? null
        : parseNonNegativeFinite(
          state.relational.lastSeenDeltaSeconds,
          'relational.lastSeenDeltaSeconds',
        ),
    },
  };
}

function normalizeDiscreteEmotions(value: Record<string, number>): Record<string, number> {
  if (!isRecord(value)) {
    throw new Error('InternalState emotional.discreteEmotions must be an object');
  }
  const entries = Object.entries(value)
    .map(([rawEmotion, rawScore]) => {
      const emotion = rawEmotion.trim().toLowerCase();
      if (!emotion) return null;
      return [emotion, parseUnit(rawScore, `emotional.discreteEmotions.${emotion}`)] as const;
    })
    .filter((entry): entry is readonly [string, number] => entry !== null)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function normalizeSalientEntities(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new Error('InternalState attention.salientEntities must be an array');
  }
  const normalized = value
    .map((entity, index) => normalizeText(entity, `attention.salientEntities[${String(index)}]`).toLowerCase())
    .filter(entity => entity.length > 0);
  const deduped = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  return deduped;
}

function normalizeProcessingQuality(value: string): InternalStateProcessingQuality {
  if (!INTERNAL_STATE_PROCESSING_QUALITIES.includes(value as InternalStateProcessingQuality)) {
    throw new Error(`InternalState cognitive.processingQuality "${String(value)}" is unsupported`);
  }
  return value as InternalStateProcessingQuality;
}

function normalizeConversationTrajectory(value: string): InternalStateConversationTrajectory {
  if (!INTERNAL_STATE_CONVERSATION_TRAJECTORIES.includes(value as InternalStateConversationTrajectory)) {
    throw new Error(`InternalState attention.conversationTrajectory "${String(value)}" is unsupported`);
  }
  return value as InternalStateConversationTrajectory;
}

function resolveCertaintyLevel(
  emotionState: EmotionStateSnapshot,
  userMessageText: string,
  responseText: string,
): number {
  const confidenceSignal = emotionState.confidence;
  const agreementSignal = resolveDiscreteAgreement(emotionState.discrete);
  const coherenceSignal = resolveResponseCoherence(userMessageText, responseText);
  return roundDecimal(clampUnit((confidenceSignal * 0.55) + (agreementSignal * 0.25) + (coherenceSignal * 0.2)));
}

function resolveDiscreteAgreement(discrete: Record<string, number>): number {
  const values = Object.values(discrete).filter(value => value > 0);
  if (values.length === 0) return 0;
  if (values.length === 1) return 1;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const entropy = values.reduce((sum, value) => {
    const probability = value / total;
    if (probability <= 0) return sum;
    return sum - (probability * Math.log2(probability));
  }, 0);
  const maxEntropy = Math.log2(values.length);
  if (!Number.isFinite(maxEntropy) || maxEntropy <= 0) return 0;
  return clampUnit(1 - (entropy / maxEntropy));
}

function resolveResponseCoherence(userMessageText: string, responseText: string): number {
  const userTokens = new Set(tokenizeEntityTerms(userMessageText));
  const responseTokens = new Set(tokenizeEntityTerms(responseText));
  if (responseTokens.size === 0 || userTokens.size === 0) {
    return responseTokens.size === 0 ? 0 : 0.2;
  }

  let intersection = 0;
  for (const token of userTokens) {
    if (responseTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...userTokens, ...responseTokens]).size;
  if (union === 0) return 0;
  return clampUnit(intersection / union);
}

function resolveTopicEngagement(
  signedArousal: number,
  userMessageText: string,
  responseText: string,
  toolCallCount: number,
): number {
  const arousalSignal = clampUnit((signedArousal + 1) / 2);
  const textSignal = clampUnit((userMessageText.length + responseText.length) / 700);
  const toolSignal = clampUnit(toolCallCount / 4);
  return roundDecimal(clampUnit((arousalSignal * 0.5) + (textSignal * 0.35) + (toolSignal * 0.15)));
}

function resolveProcessingQuality(
  certaintyLevel: number,
  responseText: string,
  toolCallCount: number,
): InternalStateProcessingQuality {
  if (responseText.length === 0 || certaintyLevel < 0.34) return 'struggling';
  if (certaintyLevel < 0.68 || toolCallCount >= 2) return 'deliberate';
  return 'fluent';
}

function resolveSalientEntities(
  userMessageText: string,
  responseText: string,
  activeConcerns: readonly ActiveConcern[],
): string[] {
  const tokenCounts = new Map<string, number>();
  const sources = [userMessageText, responseText, ...activeConcerns.map(concern => concern.text)];

  for (const source of sources) {
    for (const token of tokenizeEntityTerms(source)) {
      if (token.length < 3 || ENTITY_STOP_WORDS.has(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  return [...tokenCounts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_SALIENT_ENTITIES)
    .map(([token]) => token);
}

function resolveConversationTrajectory(
  userMessageText: string,
  responseText: string,
  activeConcernCount: number,
): InternalStateConversationTrajectory {
  const combined = `${userMessageText}\n${responseText}`.toLowerCase();
  if (containsAnyMarker(combined, WRAPPING_UP_MARKERS)) {
    return 'wrapping-up';
  }
  if (containsAnyMarker(combined, SHIFTING_MARKERS)) {
    return 'shifting';
  }
  if (
    activeConcernCount > 0
    || userMessageText.includes('?')
    || responseText.includes('?')
    || (userMessageText.length + responseText.length) >= 160
  ) {
    return 'deepening';
  }
  return 'casual';
}

function containsAnyMarker(value: string, markers: readonly string[]): boolean {
  for (const marker of markers) {
    if (value.includes(marker)) {
      return true;
    }
  }
  return false;
}

function tokenizeEntityTerms(value: string): string[] {
  const matches = value.toLowerCase().match(TOKEN_PATTERN) ?? [];
  const normalized: string[] = [];
  for (const match of matches) {
    const compact = match.trim().slice(0, MAX_SALIENT_ENTITY_LENGTH);
    if (!compact) continue;
    normalized.push(compact);
  }
  return normalized;
}

function normalizeText(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`InternalState field "${fieldName}" must be a string`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalText(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeText(value, fieldName);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIdentifier(value: string, fieldName: string): string {
  const normalized = normalizeText(value, fieldName);
  if (!normalized) {
    throw new Error(`InternalState field "${fieldName}" must not be empty`);
  }
  return normalized;
}

function normalizeOptionalIdentifier(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = normalizeText(value, fieldName);
  return normalized.length > 0 ? normalized : null;
}

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeText(value, fieldName);
  if (!normalized) {
    throw new Error(`InternalState field "${fieldName}" must not be empty`);
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`InternalState field "${fieldName}" must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function parseSigned(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`InternalState field "${fieldName}" must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`InternalState field "${fieldName}" must be in range [-1, 1]`);
  }
  return roundDecimal(value);
}

function parseUnit(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`InternalState field "${fieldName}" must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`InternalState field "${fieldName}" must be in range [0, 1]`);
  }
  return roundDecimal(value);
}

function parseNonNegativeFinite(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`InternalState field "${fieldName}" must be a finite number >= 0`);
  }
  return roundDecimal(value);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundDecimal(value: number, precision = 4): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
