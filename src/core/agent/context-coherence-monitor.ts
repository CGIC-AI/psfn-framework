import type { EventBus, EventMap } from '../../shared/event-bus.js';
import type {
  ContextCoherenceCorrelation,
  ContextCoherenceEvent,
  ContextCoherenceOperatorLabel,
  ContextCoherenceSignal,
} from '../../shared/contracts/context-coherence.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime-base.js';
import type { SessionEntry } from '../session/types.js';
import { detectCompressionFailureSignal } from '../session/compression-guideline.js';
import { deriveContextCoherenceSessionContext } from './context-coherence-session-context.js';

interface ContextCoherenceMonitorOptions {
  eventBus: EventBus;
  getRecentSessionEntries: (channelId: string, limit: number) => readonly SessionEntry[];
  now?: () => number;
}

interface PendingMissingTurn {
  expectedMinEntryId: number;
  observedMaxEntryId: number | null;
  healed: boolean;
}

interface DetectedTurnSignal {
  signal: ContextCoherenceSignal;
  detail: string;
  groundTruth: boolean;
  operatorLabel?: ContextCoherenceOperatorLabel;
}

const CONFABULATION_SELF_REPORT_RULES: ReadonlyArray<{ detail: string; regex: RegExp }> = [
  {
    detail: 'named_confabulation',
    regex: /\bi\s+(?:(?:think|realize|realized|suspect)\s+i\s+)?(?:(?:was|am|may\s+be|might\s+be|have\s+been|had\s+been)\s+confabulating|confabulated)\b/i,
  },
  {
    detail: 'named_hallucination',
    regex: /\bi\s+(?:(?:think|realize|realized|suspect)\s+i\s+)?(?:(?:was|am|may\s+be|might\s+be|have\s+been|had\s+been)\s+hallucinating|hallucinated)\b/i,
  },
  {
    detail: 'admitted_invention',
    regex: /\bi\s+(?:made|might\s+have\s+made|may\s+have\s+made|invented)\s+(?:that|it|this)\s+up\b/i,
  },
];

const OPERATOR_INTERVENTION_RULES: ReadonlyArray<{
  detail: string;
  label: ContextCoherenceOperatorLabel;
  regex: RegExp;
}> = [
  {
    detail: 'operator_named_looping',
    label: 'looping',
    regex: /\b(?:you(?:'re|\s+are)|you\s+keep)\s+(?:looping|repeating\s+yourself)\b/i,
  },
  {
    detail: 'operator_named_confusion',
    label: 'confusion',
    regex: /\byou(?:'re|\s+are|\s+seem)\s+confused\b/i,
  },
  {
    detail: 'operator_named_confabulation',
    label: 'confabulation',
    regex: /\byou(?:'re|\s+are|\s+were|\s+might\s+be)\s+(?:confabulating|hallucinating|making\s+(?:that|it|this)\s+up)\b/i,
  },
  {
    detail: 'operator_named_temporal_coherence',
    label: 'temporal_coherence',
    regex: /\byou(?:'ve|\s+have)?\s+lost\s+(?:the\s+)?(?:thread|context|turns?)\b/i,
  },
];

function detectTurnSignals(payload: EventMap['agent.turn.end']): DetectedTurnSignal[] {
  const signals: DetectedTurnSignal[] = [];
  const confusion = detectCompressionFailureSignal(payload.response.content);
  if (confusion) {
    signals.push({
      signal: 'confusion_ask',
      detail: confusion.indicator,
      groundTruth: false,
    });
  }

  if (payload.response.metadata.metacognitiveFlags?.some(flag => flag.flag === 'repetition')) {
    signals.push({
      signal: 'looping',
      detail: 'metacognitive_repetition',
      groundTruth: false,
    });
  }

  const normalizedResponse = payload.response.content.replace(/\s+/g, ' ').trim();
  const confabulation = CONFABULATION_SELF_REPORT_RULES.find(rule => rule.regex.test(normalizedResponse));
  if (confabulation) {
    signals.push({
      signal: 'confabulation_self_report',
      detail: confabulation.detail,
      groundTruth: false,
    });
  }

  if (payload.requesterProvenance === 'human' && payload.requestAudience === 'primary_contact') {
    const normalizedMessage = payload.message.content.replace(/\s+/g, ' ').trim();
    const intervention = OPERATOR_INTERVENTION_RULES.find(rule => rule.regex.test(normalizedMessage));
    if (intervention) {
      signals.push({
        signal: 'operator_intervention',
        detail: intervention.detail,
        groundTruth: true,
        operatorLabel: intervention.label,
      });
    }
  }
  return signals;
}

function buildMissingTurnCorrelation(pending: PendingMissingTurn | undefined): ContextCoherenceCorrelation[] {
  if (!pending) return [];
  return [{
    kind: 'missing_turn',
    healed: pending.healed,
    expectedMinEntryId: pending.expectedMinEntryId,
    observedMaxEntryId: pending.observedMaxEntryId,
  }];
}

function resolveTurnCorrelation(payload: EventMap['agent.turn.end']): Partial<CorrelationMetadata> {
  return {
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
  };
}

export function installContextCoherenceMonitor(options: ContextCoherenceMonitorOptions): () => void {
  const now = options.now ?? Date.now;
  const pendingMissingTurns = new Map<string, PendingMissingTurn>();
  const rememberMissingTurn = (
    payload: EventMap['session.context.stale_window_heal'] | EventMap['session.context.stale_window_heal_failed'],
    healed: boolean,
  ): void => {
    pendingMissingTurns.set(payload.requestId, {
      expectedMinEntryId: payload.expectedMinEntryId,
      observedMaxEntryId: payload.staleWindowMaxEntryId,
      healed,
    });
    if (pendingMissingTurns.size > 256) {
      const oldest = pendingMissingTurns.keys().next().value;
      if (typeof oldest === 'string') pendingMissingTurns.delete(oldest);
    }
  };

  const unsubscribeHeal = options.eventBus.on('session.context.stale_window_heal', payload => {
    rememberMissingTurn(payload, payload.healed);
  });
  const unsubscribeHealFailure = options.eventBus.on('session.context.stale_window_heal_failed', payload => {
    rememberMissingTurn(payload, false);
  });
  const unsubscribeTurnEnd = options.eventBus.on('agent.turn.end', async payload => {
    const correlation = resolveTurnCorrelation(payload);
    const requestId = correlation.requestId ?? payload.response.metadata.requestId;
    const pending = requestId ? pendingMissingTurns.get(requestId) : undefined;
    if (requestId) pendingMissingTurns.delete(requestId);
    const entries = options.getRecentSessionEntries(payload.message.channelId, 24);
    const activeConcerns = payload.response.metadata.internalState?.attention.activeConcerns;
    const context = deriveContextCoherenceSessionContext(
      entries,
      payload.message.timestamp.getTime(),
      Array.isArray(activeConcerns) ? activeConcerns.length : null,
    );
    const detected = detectTurnSignals(payload);

    for (const signal of detected) {
      const event: ContextCoherenceEvent = {
        schemaVersion: 1,
        id: `${String(correlation.turnId ?? payload.message.id)}:${signal.signal}`,
        signal: signal.signal,
        source: 'turn_end',
        timestamp: now(),
        channelId: payload.message.channelId,
        ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
        ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
        ...(requestId ? { requestId } : {}),
        detail: signal.detail,
        groundTruth: signal.groundTruth,
        ...(signal.operatorLabel ? { operatorLabel: signal.operatorLabel } : {}),
        context,
        correlations: buildMissingTurnCorrelation(pending),
        eligibleForEmotionAppraisal: false,
        eligibleForMemoryCandidacy: false,
      };
      await options.eventBus.emit('context.coherence.detected', event);
    }
  });

  return () => {
    unsubscribeHeal();
    unsubscribeHealFailure();
    unsubscribeTurnEnd();
    pendingMissingTurns.clear();
  };
}
