import type {
  IntentionalNoReplyMetadata,
  ResponseMetadata,
} from '../../shared/contracts/runtime.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../shared/utils/types.js';
import { parseTurnId } from '../turns/id.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  type InternalState,
} from '../self-model/state.js';
import {
  METACOGNITIVE_FLAG_NAMES,
  type MetacognitiveFlag,
} from '../self-model/metacognition.js';
import {
  assertExactKeys,
  optionalString,
  parseStringArray,
  requireBoolean,
  requireEnum,
  requireFinite,
  requireRecord,
  requireString,
} from './icp-recovery-metadata-validation.js';
import {
  parseFatigue,
  parsePendingSpend,
} from './icp-recovery-fatigue-metadata.js';
import { assertFatigueRecoveryBinding } from './icp-recovery-fatigue-binding.js';

const METADATA_KEYS = new Set([
  'model',
  'inputTokens',
  'outputTokens',
  'durationMs',
  'turnId',
  'requestId',
  'icpCorrelation',
  'noReply',
  'internalState',
  'internalStateSnapshotRef',
  'metacognitiveFlags',
  'retrievalProvenanceRefs',
  'diagnostics',
  'broadcastSafety',
  'fatigue',
  'fatiguePendingSpend',
]);

function parseNoReply(
  value: unknown,
  label: string,
  expected: { turnId: string; requestId: string; channelId: string },
): IntentionalNoReplyMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'schemaVersion',
    'disposition',
    'source',
    'auditId',
    'decidedAt',
    'turnId',
    'requestId',
    'channelId',
    'toolCallId',
    'reason',
  ]), label);
  const turnId = parseTurnId(raw.turnId, `${label}.turnId`);
  const requestId = optionalString(raw.requestId, `${label}.requestId`);
  const channelId = optionalString(raw.channelId, `${label}.channelId`);
  if (raw.schemaVersion !== 1
    || raw.disposition !== 'intentional_no_reply'
    || raw.source !== 'response_control_tool'
    || !turnId
    || turnId !== expected.turnId
    || (requestId !== undefined && requestId !== expected.requestId)
    || (channelId !== undefined && channelId !== expected.channelId)) {
    throw new Error(`${label} does not match its response lineage`);
  }
  const toolCallId = optionalString(raw.toolCallId, `${label}.toolCallId`);
  const reason = optionalString(raw.reason, `${label}.reason`);
  return {
    schemaVersion: 1,
    disposition: 'intentional_no_reply',
    source: 'response_control_tool',
    auditId: requireString(raw.auditId, `${label}.auditId`),
    decidedAt: requireFinite(raw.decidedAt, `${label}.decidedAt`),
    turnId,
    ...(requestId ? { requestId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function isInternalStateShape(value: unknown): value is InternalState {
  if (!isRecord(value)
    || !isRecord(value.emotional)
    || !isRecord(value.emotional.vad)
    || !isRecord(value.emotional.mood)
    || !isRecord(value.emotional.discreteEmotions)
    || !isRecord(value.cognitive)
    || !isRecord(value.attention)
    || !Array.isArray(value.attention.activeConcerns)
    || !Array.isArray(value.attention.salientEntities)
    || !isRecord(value.relational)
    || !isRecord(value.situated)) {
    return false;
  }
  return true;
}

function parseInternalState(value: unknown, label: string): InternalState {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set(['emotional', 'cognitive', 'attention', 'relational', 'situated']), label);
  const emotional = requireRecord(raw.emotional, `${label}.emotional`);
  const cognitive = requireRecord(raw.cognitive, `${label}.cognitive`);
  const attention = requireRecord(raw.attention, `${label}.attention`);
  const relational = requireRecord(raw.relational, `${label}.relational`);
  const situated = requireRecord(raw.situated, `${label}.situated`);
  assertExactKeys(emotional, new Set([
    'vad', 'mood', 'discreteEmotions', 'confidence', 'telemetry', 'acac',
  ]), `${label}.emotional`);
  assertExactKeys(cognitive, new Set([
    'certaintyLevel', 'topicEngagement', 'processingQuality',
  ]), `${label}.cognitive`);
  assertExactKeys(attention, new Set([
    'activeConcerns',
    'pendingFollowUps',
    'careReminders',
    'salientEntities',
    'conversationTrajectory',
  ]), `${label}.attention`);
  assertExactKeys(relational, new Set([
    'contactId',
    'trustLevel',
    'baselineValence',
    'moodDrift',
    'recentInteractionFrequency',
    'lastSeenDeltaSeconds',
  ]), `${label}.relational`);
  assertExactKeys(situated, new Set(['location']), `${label}.situated`);
  for (const field of ['vad', 'mood'] as const) {
    const vector = requireRecord(emotional[field], `${label}.emotional.${field}`);
    assertExactKeys(vector, new Set(['valence', 'arousal', 'dominance']), `${label}.emotional.${field}`);
  }
  if (!isInternalStateShape(value)) throw new Error(`${label} is malformed`);
  return cloneInternalState(value);
}

function parseMetacognitiveFlags(value: unknown, label: string): MetacognitiveFlag[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const raw = requireRecord(entry, itemLabel);
    assertExactKeys(raw, new Set(['flag', 'confidence', 'evidence']), itemLabel);
    const confidence = requireFinite(raw.confidence, `${itemLabel}.confidence`);
    if (confidence > 1) throw new Error(`${itemLabel}.confidence must be at most 1`);
    return {
      flag: requireEnum(raw.flag, METACOGNITIVE_FLAG_NAMES, `${itemLabel}.flag`),
      confidence,
      evidence: requireString(raw.evidence, `${itemLabel}.evidence`),
    };
  });
}

function parseDiagnostics(
  value: unknown,
  label: string,
): NonNullable<ResponseMetadata['diagnostics']> {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set(['fallback', 'runtimeContradiction']), label);
  const result: NonNullable<ResponseMetadata['diagnostics']> = {};
  if (raw.fallback !== undefined) {
    const fallback = requireRecord(raw.fallback, `${label}.fallback`);
    assertExactKeys(fallback, new Set([
      'code',
      'strategy',
      'attempts',
      'finalContentEmpty',
      'previousStopReason',
      'previousErrorMessage',
      'runtimeFallbackApplied',
    ]), `${label}.fallback`);
    const previousStopReason = optionalString(
      fallback.previousStopReason,
      `${label}.fallback.previousStopReason`,
    );
    const previousErrorMessage = optionalString(
      fallback.previousErrorMessage,
      `${label}.fallback.previousErrorMessage`,
    );
    result.fallback = {
      code: requireEnum(fallback.code, [
        'vision_empty_response',
        'vision_content_unavailable',
        'vision_prompt_unavailable',
      ], `${label}.fallback.code`),
      strategy: requireEnum(fallback.strategy, [
        'replay_transport_content',
        'text_only_unavailable_notice',
        'runtime_nonfabricating_notice',
      ], `${label}.fallback.strategy`),
      attempts: requireFinite(fallback.attempts, `${label}.fallback.attempts`),
      finalContentEmpty: requireBoolean(
        fallback.finalContentEmpty,
        `${label}.fallback.finalContentEmpty`,
      ),
      ...(previousStopReason ? { previousStopReason } : {}),
      ...(previousErrorMessage ? { previousErrorMessage } : {}),
      ...(fallback.runtimeFallbackApplied !== undefined
        ? {
            runtimeFallbackApplied: requireBoolean(
              fallback.runtimeFallbackApplied,
              `${label}.fallback.runtimeFallbackApplied`,
            ),
          }
        : {}),
    };
  }
  if (raw.runtimeContradiction !== undefined) {
    const contradiction = requireRecord(
      raw.runtimeContradiction,
      `${label}.runtimeContradiction`,
    );
    assertExactKeys(contradiction, new Set([
      'code',
      'anchorDetected',
      'matchedSignals',
      'attempts',
      'retryAttempted',
      'retrySucceeded',
      'refusalApplied',
    ]), `${label}.runtimeContradiction`);
    if (contradiction.code !== 'runtime_datetime_anchor_contradiction') {
      throw new Error(`${label}.runtimeContradiction.code is unsupported`);
    }
    result.runtimeContradiction = {
      code: 'runtime_datetime_anchor_contradiction',
      anchorDetected: requireBoolean(
        contradiction.anchorDetected,
        `${label}.runtimeContradiction.anchorDetected`,
      ),
      matchedSignals: parseStringArray(
        contradiction.matchedSignals,
        `${label}.runtimeContradiction.matchedSignals`,
      ),
      attempts: requireFinite(
        contradiction.attempts,
        `${label}.runtimeContradiction.attempts`,
      ),
      retryAttempted: requireBoolean(
        contradiction.retryAttempted,
        `${label}.runtimeContradiction.retryAttempted`,
      ),
      retrySucceeded: requireBoolean(
        contradiction.retrySucceeded,
        `${label}.runtimeContradiction.retrySucceeded`,
      ),
      refusalApplied: requireBoolean(
        contradiction.refusalApplied,
        `${label}.runtimeContradiction.refusalApplied`,
      ),
    };
  }
  return result;
}

function parseBroadcastSafety(
  value: unknown,
  label: string,
): NonNullable<ResponseMetadata['broadcastSafety']> {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'visibilityScope',
    'operatorApproval',
    'risky',
    'signals',
    'approvalRequired',
    'provenanceRefs',
  ]), label);
  if (!Array.isArray(raw.signals)) throw new Error(`${label}.signals must be an array`);
  return {
    visibilityScope: requireEnum(
      raw.visibilityScope,
      ['public_only', 'approved_private_context'],
      `${label}.visibilityScope`,
    ),
    operatorApproval: requireBoolean(raw.operatorApproval, `${label}.operatorApproval`),
    risky: requireBoolean(raw.risky, `${label}.risky`),
    signals: raw.signals.map((signal, index) => requireEnum(
      signal,
      ['sensitive', 'private', 'off_brand'],
      `${label}.signals[${index}]`,
    )),
    approvalRequired: requireBoolean(raw.approvalRequired, `${label}.approvalRequired`),
    provenanceRefs: parseStringArray(raw.provenanceRefs, `${label}.provenanceRefs`),
  };
}

export function parseIcpRecoveryResponseMetadata(value: unknown, label: string): ResponseMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, METADATA_KEYS, label);
  const model = requireString(raw.model, `${label}.model`);
  const inputTokens = requireFinite(raw.inputTokens, `${label}.inputTokens`);
  const outputTokens = requireFinite(raw.outputTokens, `${label}.outputTokens`);
  const durationMs = requireFinite(raw.durationMs, `${label}.durationMs`);
  const correlation = parseIcpConversationCorrelation(raw.icpCorrelation);
  const turnId = parseTurnId(raw.turnId, `${label}.turnId`);
  const requestId = requireString(raw.requestId, `${label}.requestId`);
  if (!turnId || turnId !== correlation.turnId || requestId !== correlation.requestId) {
    throw new Error(`${label} does not match its durable ICP lineage`);
  }
  const internalState = raw.internalState === undefined
    ? undefined
    : parseInternalState(raw.internalState, `${label}.internalState`);
  const internalStateSnapshotRef = raw.internalStateSnapshotRef === undefined
    ? undefined
    : requireString(raw.internalStateSnapshotRef, `${label}.internalStateSnapshotRef`);
  if ((internalState === undefined) !== (internalStateSnapshotRef === undefined)) {
    throw new Error(`${label} internal state and snapshot reference must be a pair`);
  }
  if (internalState && internalStateSnapshotRef
    && buildInternalStateSnapshotRef(internalState) !== internalStateSnapshotRef) {
    throw new Error(`${label} snapshot reference does not match its internal state`);
  }
  const fatigue = raw.fatigue === undefined
    ? undefined
    : parseFatigue(raw.fatigue, `${label}.fatigue`);
  const fatiguePendingSpend = raw.fatiguePendingSpend === undefined
    ? undefined
    : parsePendingSpend(raw.fatiguePendingSpend, `${label}.fatiguePendingSpend`);
  assertFatigueRecoveryBinding({
    fatigue,
    pendingSpend: fatiguePendingSpend,
    correlation,
    turnId,
    requestId,
    label,
  });
  return {
    model,
    inputTokens,
    outputTokens,
    durationMs,
    turnId,
    requestId,
    icpCorrelation: correlation,
    ...(raw.noReply !== undefined
      ? {
          noReply: parseNoReply(raw.noReply, `${label}.noReply`, {
            turnId,
            requestId,
            channelId: correlation.channelId,
          }),
        }
      : {}),
    ...(internalState !== undefined
      ? { internalState }
      : {}),
    ...(internalStateSnapshotRef !== undefined
      ? { internalStateSnapshotRef }
      : {}),
    ...(raw.metacognitiveFlags !== undefined
      ? {
          metacognitiveFlags: parseMetacognitiveFlags(
            raw.metacognitiveFlags,
            `${label}.metacognitiveFlags`,
          ),
        }
      : {}),
    ...(raw.retrievalProvenanceRefs !== undefined
      ? {
          retrievalProvenanceRefs: parseStringArray(
            raw.retrievalProvenanceRefs,
            `${label}.retrievalProvenanceRefs`,
          ),
        }
      : {}),
    ...(raw.diagnostics !== undefined
      ? { diagnostics: parseDiagnostics(raw.diagnostics, `${label}.diagnostics`) }
      : {}),
    ...(raw.broadcastSafety !== undefined
      ? {
          broadcastSafety: parseBroadcastSafety(
            raw.broadcastSafety,
            `${label}.broadcastSafety`,
          ),
        }
      : {}),
    ...(fatigue !== undefined
      ? { fatigue }
      : {}),
    ...(fatiguePendingSpend !== undefined
      ? { fatiguePendingSpend }
      : {}),
  };
}
