import { isRecord } from '../../shared/utils/types.js';
import { TRUST_LEVELS, type TrustLevel } from '../../system/trust/types.js';
import {
  EMOTION_TELEMETRY_REASONS,
  EMOTION_TELEMETRY_SOURCES,
  EMOTION_TELEMETRY_STATUSES,
  type EmotionTelemetryReason,
  type EmotionTelemetrySource,
  type EmotionTelemetryStatus,
} from './telemetry-validation.js';
import type { VADVector } from './state.js';
import {
  INTERNAL_STATE_CONVERSATION_TRAJECTORIES,
  INTERNAL_STATE_PROCESSING_QUALITIES,
  cloneInternalState,
  type InternalState,
  type InternalStateConversationTrajectory,
  type InternalStateProcessingQuality,
} from '../self-model/state.js';

const MAX_DISCRETE_EMOTIONS = 32;
const MAX_DISCRETE_LABEL_CHARS = 64;
const MAX_CONTACT_REF_CHARS = 256;

/**
 * Content-free projection of InternalState containing only the aggregate
 * signals consumed by emotion appraisal. Durable background jobs persist this
 * view plus the canonical snapshot ref, never concern text, follow-ups,
 * reminders, salient-entity text, or the rest of the private state snapshot.
 */
export interface EmotionAppraisalStateSnapshot {
  schemaVersion: 1;
  emotional: {
    vad: VADVector;
    mood: VADVector;
    discreteEmotions: Record<string, number>;
    confidence: number;
    telemetry: {
      status: EmotionTelemetryStatus;
      source: EmotionTelemetrySource;
      reasons: EmotionTelemetryReason[];
      weight: number;
    };
  };
  cognitive: {
    certaintyLevel: number;
    topicEngagement: number;
    processingQuality: InternalStateProcessingQuality;
  };
  attention: {
    activeConcernCount: number;
    salientEntityCount: number;
    conversationTrajectory: InternalStateConversationTrajectory;
  };
  relational: {
    contactId: string | null;
    trustLevel: TrustLevel;
    moodDrift: number;
  };
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).find(key => !allowed.has(key));
  if (unsupported) {
    throw new Error(`${field} contains unsupported field ${unsupported}`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function parseSigned(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${field} must be a finite number in range [-1, 1]`);
  }
  return value;
}

function parseUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number in range [0, 1]`);
  }
  return value;
}

function parseCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseVad(value: unknown, field: string): VADVector {
  const record = requireRecord(value, field);
  assertOnlyKeys(record, ['valence', 'arousal', 'dominance'], field);
  return {
    valence: parseSigned(record.valence, `${field}.valence`),
    arousal: parseSigned(record.arousal, `${field}.arousal`),
    dominance: parseSigned(record.dominance, `${field}.dominance`),
  };
}

function parseDiscreteEmotions(value: unknown): Record<string, number> {
  const record = requireRecord(value, 'emotion appraisal state emotional.discreteEmotions');
  const entries = Object.entries(record);
  if (entries.length > MAX_DISCRETE_EMOTIONS) {
    throw new Error(`emotion appraisal state supports at most ${String(MAX_DISCRETE_EMOTIONS)} discrete emotions`);
  }
  const normalized = entries.map(([rawLabel, rawScore]) => {
    const label = rawLabel.trim().toLowerCase();
    if (!label || label.length > MAX_DISCRETE_LABEL_CHARS) {
      throw new Error('emotion appraisal state contains an invalid discrete-emotion label');
    }
    return [label, parseUnit(rawScore, `emotion appraisal state discreteEmotions.${label}`)] as const;
  });
  normalized.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalized);
}

function parseTelemetry(value: unknown): EmotionAppraisalStateSnapshot['emotional']['telemetry'] {
  const record = requireRecord(value, 'emotion appraisal state emotional.telemetry');
  assertOnlyKeys(record, ['status', 'source', 'reasons', 'weight'], 'emotion appraisal state emotional.telemetry');
  if (!EMOTION_TELEMETRY_STATUSES.includes(record.status as EmotionTelemetryStatus)) {
    throw new Error('emotion appraisal state telemetry.status is invalid');
  }
  if (!EMOTION_TELEMETRY_SOURCES.includes(record.source as EmotionTelemetrySource)) {
    throw new Error('emotion appraisal state telemetry.source is invalid');
  }
  if (!Array.isArray(record.reasons)) {
    throw new Error('emotion appraisal state telemetry.reasons must be an array');
  }
  const reasons = [...new Set(record.reasons.map((reason) => {
    if (!EMOTION_TELEMETRY_REASONS.includes(reason as EmotionTelemetryReason)) {
      throw new Error('emotion appraisal state telemetry.reasons contains an invalid reason');
    }
    return reason as EmotionTelemetryReason;
  }))].sort();
  return {
    status: record.status as EmotionTelemetryStatus,
    source: record.source as EmotionTelemetrySource,
    reasons,
    weight: parseUnit(record.weight, 'emotion appraisal state telemetry.weight'),
  };
}

/** Parse the durable appraisal projection at the queue trust boundary. */
export function parseEmotionAppraisalStateSnapshot(value: unknown): EmotionAppraisalStateSnapshot {
  const root = requireRecord(value, 'emotion appraisal state');
  assertOnlyKeys(root, ['schemaVersion', 'emotional', 'cognitive', 'attention', 'relational'], 'emotion appraisal state');
  if (root.schemaVersion !== 1) {
    throw new Error('emotion appraisal state must use schemaVersion 1');
  }

  const emotional = requireRecord(root.emotional, 'emotion appraisal state emotional');
  assertOnlyKeys(
    emotional,
    ['vad', 'mood', 'discreteEmotions', 'confidence', 'telemetry'],
    'emotion appraisal state emotional',
  );
  const cognitive = requireRecord(root.cognitive, 'emotion appraisal state cognitive');
  assertOnlyKeys(
    cognitive,
    ['certaintyLevel', 'topicEngagement', 'processingQuality'],
    'emotion appraisal state cognitive',
  );
  if (!INTERNAL_STATE_PROCESSING_QUALITIES.includes(
    cognitive.processingQuality as InternalStateProcessingQuality,
  )) {
    throw new Error('emotion appraisal state cognitive.processingQuality is invalid');
  }
  const attention = requireRecord(root.attention, 'emotion appraisal state attention');
  assertOnlyKeys(
    attention,
    ['activeConcernCount', 'salientEntityCount', 'conversationTrajectory'],
    'emotion appraisal state attention',
  );
  if (!INTERNAL_STATE_CONVERSATION_TRAJECTORIES.includes(
    attention.conversationTrajectory as InternalStateConversationTrajectory,
  )) {
    throw new Error('emotion appraisal state attention.conversationTrajectory is invalid');
  }
  const relational = requireRecord(root.relational, 'emotion appraisal state relational');
  assertOnlyKeys(
    relational,
    ['contactId', 'trustLevel', 'moodDrift'],
    'emotion appraisal state relational',
  );
  const contactId = relational.contactId === null
    ? null
    : (() => {
      if (typeof relational.contactId !== 'string') {
        throw new Error('emotion appraisal state relational.contactId must be a string or null');
      }
      const normalized = relational.contactId.trim();
      if (!normalized || normalized.length > MAX_CONTACT_REF_CHARS) {
        throw new Error('emotion appraisal state relational.contactId is invalid');
      }
      return normalized;
    })();
  if (!TRUST_LEVELS.includes(relational.trustLevel as TrustLevel)) {
    throw new Error('emotion appraisal state relational.trustLevel is invalid');
  }

  return {
    schemaVersion: 1,
    emotional: {
      vad: parseVad(emotional.vad, 'emotion appraisal state emotional.vad'),
      mood: parseVad(emotional.mood, 'emotion appraisal state emotional.mood'),
      discreteEmotions: parseDiscreteEmotions(emotional.discreteEmotions),
      confidence: parseUnit(emotional.confidence, 'emotion appraisal state emotional.confidence'),
      telemetry: parseTelemetry(emotional.telemetry),
    },
    cognitive: {
      certaintyLevel: parseUnit(
        cognitive.certaintyLevel,
        'emotion appraisal state cognitive.certaintyLevel',
      ),
      topicEngagement: parseUnit(
        cognitive.topicEngagement,
        'emotion appraisal state cognitive.topicEngagement',
      ),
      processingQuality: cognitive.processingQuality as InternalStateProcessingQuality,
    },
    attention: {
      activeConcernCount: parseCount(
        attention.activeConcernCount,
        'emotion appraisal state attention.activeConcernCount',
      ),
      salientEntityCount: parseCount(
        attention.salientEntityCount,
        'emotion appraisal state attention.salientEntityCount',
      ),
      conversationTrajectory: attention.conversationTrajectory as InternalStateConversationTrajectory,
    },
    relational: {
      contactId,
      trustLevel: relational.trustLevel as TrustLevel,
      moodDrift: parseSigned(relational.moodDrift, 'emotion appraisal state relational.moodDrift'),
    },
  };
}

/** Build the minimal durable input while preserving every signal appraisal reads. */
export function projectEmotionAppraisalState(
  internalState: InternalState,
): EmotionAppraisalStateSnapshot {
  const normalized = cloneInternalState(internalState);
  const discreteEmotions = Object.fromEntries(
    Object.entries(normalized.emotional.discreteEmotions)
      .sort(([leftLabel, leftScore], [rightLabel, rightScore]) => (
        rightScore - leftScore || leftLabel.localeCompare(rightLabel)
      ))
      .slice(0, MAX_DISCRETE_EMOTIONS),
  );
  return parseEmotionAppraisalStateSnapshot({
    schemaVersion: 1,
    emotional: {
      vad: normalized.emotional.vad,
      mood: normalized.emotional.mood,
      discreteEmotions,
      confidence: normalized.emotional.confidence,
      telemetry: {
        status: normalized.emotional.telemetry.status,
        source: normalized.emotional.telemetry.source,
        reasons: normalized.emotional.telemetry.reasons,
        weight: normalized.emotional.telemetry.weight,
      },
    },
    cognitive: normalized.cognitive,
    attention: {
      activeConcernCount: normalized.attention.activeConcerns.length,
      salientEntityCount: normalized.attention.salientEntities.length,
      conversationTrajectory: normalized.attention.conversationTrajectory,
    },
    relational: {
      contactId: normalized.relational.contactId,
      trustLevel: normalized.relational.trustLevel,
      moodDrift: normalized.relational.moodDrift,
    },
  });
}
