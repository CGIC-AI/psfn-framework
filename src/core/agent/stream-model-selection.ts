import type { ModelThinkingEffort } from '../../shared/contracts/runtime.js';
import type { LLMModelHint } from '../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  resolveCandidates,
  resolveModelSelectionSlotForPurpose,
} from '../../primitives/llm/model-hint-routing.js';
import {
  resolveRoutingCandidates,
  type RoutingCandidate,
  type RoutingPurpose,
} from '../../primitives/llm/routing.js';

export interface CompanionStreamRoute {
  candidates: RoutingCandidate[];
  selectedSlotKey?: string;
}

/**
 * Resolve the per-companion selection before the shared fleet model is mounted.
 * The selected chain must lead interactive chat even while pi-agent state still
 * identifies the shared default; ordinary fallback candidates stay attached.
 */
export function resolveCompanionStreamRoute(
  config: CoreSubstrateConfig,
  purpose: RoutingPurpose,
): CompanionStreamRoute {
  const selectedSlotKey = resolveModelSelectionSlotForPurpose(
    config.modelPurposeSelection,
    purpose,
  );
  if (!selectedSlotKey) {
    return { candidates: resolveRoutingCandidates(config, purpose) };
  }
  return {
    candidates: resolveCandidates(config, purpose, { slotKey: selectedSlotKey }),
    selectedSlotKey,
  };
}

/** Carry slot identity only when this companion configured the current lane. */
export function resolveCompanionTransportSlotKey(
  config: CoreSubstrateConfig,
  purpose: RoutingPurpose,
  candidate: RoutingCandidate,
): string | undefined {
  return resolveModelSelectionSlotForPurpose(config.modelPurposeSelection, purpose)
    ? candidate.slotKey
    : undefined;
}

export function buildStreamTransportModelHint(
  candidate: RoutingCandidate,
  requestOptions: Record<string, unknown>,
  transportSlotKey: string | undefined,
): LLMModelHint {
  const reasoning = requestOptions.reasoning;
  return {
    model: candidate.model,
    provider: candidate.provider,
    ...(transportSlotKey ? { slotKey: transportSlotKey } : {}),
    pin: true,
    maxTokens: candidate.maxTokens,
    ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
    ...(candidate.temperature !== undefined ? { temperature: candidate.temperature } : {}),
    ...(candidate.topP !== undefined ? { topP: candidate.topP } : {}),
    ...(candidate.topK !== undefined ? { topK: candidate.topK } : {}),
    ...(candidate.frequencyPenalty !== undefined ? { frequencyPenalty: candidate.frequencyPenalty } : {}),
    ...(candidate.repetitionPenalty !== undefined ? { repetitionPenalty: candidate.repetitionPenalty } : {}),
    ...(candidate.thinkingEnabled !== undefined ? { thinkingEnabled: candidate.thinkingEnabled } : {}),
    ...(typeof reasoning === 'string' ? { thinkingEffort: reasoning as ModelThinkingEffort } : {}),
  };
}
