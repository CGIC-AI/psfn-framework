import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import {
  MODEL_THINKING_EFFORT_VALUES,
  type ModelThinkingEffort,
} from '../../shared/contracts/runtime-base.js';
import { resolveRegisteredModel, type ModelLookupRuntime } from './models.js';
import type { RoutingCandidate } from './routing.js';

export type ReasoningSupportSource =
  | 'tuning_disabled'
  | 'registry_capability'
  | 'tuning_enabled'
  | 'catalogue'
  | 'undeclared';

export interface CandidateReasoningSupport {
  /** True when a reasoning effort sent for this candidate reaches the provider. */
  reasoning: boolean;
  /** Effort levels the bound model accepts, least to most. Empty when it cannot reason. */
  levels: readonly ModelThinkingEffort[];
  /** Provider level names from the catalogue, so routed endpoints map levels the same way. */
  thinkingLevelMap?: ThinkingLevelMap;
  source: ReasoningSupportSource;
}

type ReasoningCandidate = Pick<
  RoutingCandidate,
  'provider' | 'model' | 'supportsReasoning' | 'thinkingEnabled'
>;

function supportedEfforts(thinkingLevelMap: ThinkingLevelMap | undefined): ModelThinkingEffort[] {
  const levels = getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap } as Model<Api>);
  return MODEL_THINKING_EFFORT_VALUES.filter(level => levels.includes(level));
}

/**
 * Whether a candidate can carry a reasoning effort, and which levels it takes.
 *
 * An explicit models.json `capabilities.supportsReasoning` (or
 * `tuning.thinkingEnabled`) is the owner's statement and wins. Without one, the
 * provider catalogue entry for the same provider/model decides, so a routed
 * OpenRouter slot that never declared the capability still reasons when the
 * catalogue says it can. `tuning.thinkingEnabled: false` always disables it.
 */
export function resolveCandidateReasoningSupport(
  catalogue: ModelLookupRuntime,
  candidate: ReasoningCandidate,
): CandidateReasoningSupport {
  if (candidate.thinkingEnabled === false) {
    return { reasoning: false, levels: [], source: 'tuning_disabled' };
  }
  const catalogueModel = resolveRegisteredModel(catalogue, candidate.provider, candidate.model);
  const thinkingLevelMap = catalogueModel?.thinkingLevelMap;
  const supported = (source: ReasoningSupportSource): CandidateReasoningSupport => ({
    reasoning: true,
    levels: supportedEfforts(thinkingLevelMap),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    source,
  });
  if (typeof candidate.supportsReasoning === 'boolean') {
    return candidate.supportsReasoning
      ? supported('registry_capability')
      : { reasoning: false, levels: [], source: 'registry_capability' };
  }
  if (candidate.thinkingEnabled === true) return supported('tuning_enabled');
  if (catalogueModel?.reasoning === true) return supported('catalogue');
  return { reasoning: false, levels: [], source: 'undeclared' };
}

/** Bound a requested level to what the model accepts (pi-ai's own clamping order). */
export function clampEffortToSupport(
  requested: ModelThinkingEffort,
  support: CandidateReasoningSupport,
): ModelThinkingEffort | undefined {
  if (!support.reasoning || support.levels.length === 0) return undefined;
  if (support.levels.includes(requested)) return requested;
  const clamped = clampThinkingLevel(
    { reasoning: true, thinkingLevelMap: support.thinkingLevelMap } as Model<Api>,
    requested,
  );
  return support.levels.find(level => level === clamped);
}
