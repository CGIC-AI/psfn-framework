import { countTokens } from '../../../primitives/llm/tokens.js';
import {
  MEMORY_RETRIEVAL_MIN_ITEMS,
  resolveMemoryRetrievalBudget,
  type ContextBudgetConfigLike,
  type ContextBudgetTurnCharacteristics,
} from '../../../shared/context-budget.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { PurrMemory } from '../types.js';
import {
  resolveMemoryRetrievalPolicy,
  resolveMemorySelectionCap,
  type MemoryRetrievalPolicy,
} from '../../../system/config/memory-retrieval-policy.js';
import type {
  RetrievalSelectionDecision,
  ScoredMemory,
} from './types.js';

const RELEVANCE_TERMINATION_ABSOLUTE_FLOOR = 0.02;
const RELEVANCE_TERMINATION_RELATIVE_FLOOR = 0.12;

function estimateMemoryPromptTokens(memory: PurrMemory): number {
  return Math.max(1, countTokens(`[${memory.type}] ${memory.text}`));
}

export function resolveGuaranteedSelectionFloor(
  rankedLength: number,
  scoreGuaranteedCount: number,
  policyInput?: MemoryRetrievalPolicy,
): number {
  if (scoreGuaranteedCount > 0) {
    const scoreGuaranteeMinK = resolveMemoryRetrievalPolicy(policyInput).scoreGuaranteeMinK;
    return Math.min(rankedLength, Math.max(MEMORY_RETRIEVAL_MIN_ITEMS, scoreGuaranteeMinK));
  }
  return Math.min(rankedLength, MEMORY_RETRIEVAL_MIN_ITEMS);
}

export function resolveMemoryRetrieverBudget(
  runtimeConfig: SubstrateConfig | null,
  fallbackBudgetConfig: ContextBudgetConfigLike | null,
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
): ReturnType<typeof resolveMemoryRetrievalBudget> {
  if (runtimeConfig) {
    return resolveMemoryRetrievalBudget(runtimeConfig, {
      ...(turnBudgetCharacteristics ? { turn: turnBudgetCharacteristics } : {}),
    });
  }

  return resolveMemoryRetrievalBudget(
    fallbackBudgetConfig ?? {
      defaultContextWindow: 128_000,
      modelRoster: {},
    },
    {
      ...(turnBudgetCharacteristics ? { turn: turnBudgetCharacteristics } : {}),
    },
  );
}

export function selectWithinRelevanceAndTokenBudget(
  scored: ScoredMemory[],
  tokenBudget: number,
  minimumSelectedCount = MEMORY_RETRIEVAL_MIN_ITEMS,
  policyInput?: MemoryRetrievalPolicy,
): RetrievalSelectionDecision {
  const policy = resolveMemoryRetrievalPolicy(policyInput);
  const selectionFloor = Math.max(1, Math.min(minimumSelectedCount, scored.length));

  if (scored.length === 0) {
    return {
      selected: [],
      stopReason: 'exhausted',
      relevanceStoppedCount: 0,
      budgetCappedCount: 0,
      relevanceScoreFloor: RELEVANCE_TERMINATION_ABSOLUTE_FLOOR,
      selectionCapSkippedCount: ZERO_QUOTA_SKIP_COUNT,
      selectionCapSkippedByType: {},
    };
  }

  const floorAnchorScore = resolveRelevanceFloorAnchorScore(scored, policy);
  const relevanceScoreFloor = Math.max(
    RELEVANCE_TERMINATION_ABSOLUTE_FLOOR, floorAnchorScore * RELEVANCE_TERMINATION_RELATIVE_FLOOR);
  let usedTokens = 0;
  const selected: ScoredMemory[] = [];
  let stopReason: RetrievalSelectionDecision['stopReason'] = 'exhausted';
  let relevanceStoppedCount = 0, budgetCappedCount = 0;
  let skippedByTypeQuota = 0;
  const skippedByTypeQuotaMap: Record<string, number> = {};
  const selectedTypeCounts = new Map<string, number>();

  for (let index = 0; index < scored.length; index++) {
    const item = scored[index];
    if (item === undefined) {
      continue;
    }
    const selectionCap = resolveMemorySelectionCap(policy, item.memory.type);
    if (
      selectionCap !== undefined
      && (selectedTypeCounts.get(item.memory.type) ?? 0) >= selectionCap
    ) {
      skippedByTypeQuota += 1;
      skippedByTypeQuotaMap[item.memory.type] = (skippedByTypeQuotaMap[item.memory.type] ?? 0) + 1;
      continue;
    }
    const itemTokens = estimateMemoryPromptTokens(item.memory);

    if (selected.length >= selectionFloor) {
      if (item.score < relevanceScoreFloor) {
        stopReason = 'relevance';
        relevanceStoppedCount = scored.length - index;
        break;
      }

      if (tokenBudget <= 0 || usedTokens + itemTokens > tokenBudget) {
        stopReason = 'budget';
        budgetCappedCount = scored.length - index;
        break;
      }
    }

    selected.push(item);
    selectedTypeCounts.set(
      item.memory.type,
      (selectedTypeCounts.get(item.memory.type) ?? 0) + 1,
    );
    usedTokens += itemTokens;
  }

  return {
    selected,
    stopReason,
    relevanceStoppedCount,
    budgetCappedCount,
    relevanceScoreFloor,
    selectionCapSkippedCount: skippedByTypeQuota,
    selectionCapSkippedByType: skippedByTypeQuotaMap,
  };
}

const ZERO_QUOTA_SKIP_COUNT = 0;

/**
 * Anchors the relative relevance floor on genuine non-augment, uncapped
 * candidates when present so a single lexical-augment hit or capped reflection
 * burst cannot inflate the floor and crush semantic recall (psfn-framework-d5e0p.19).
 */
function resolveRelevanceFloorAnchorScore(
  scored: readonly ScoredMemory[],
  policy: MemoryRetrievalPolicy,
): number {
  const uncappedSemantic = scored.find(item => (
    item.memory.retrievalChannel !== 'lexical_augment'
    && resolveMemorySelectionCap(policy, item.memory.type) === undefined
  ));
  if (uncappedSemantic !== undefined) {
    return uncappedSemantic.score;
  }
  const nonAugment = scored.find(item => item.memory.retrievalChannel !== 'lexical_augment');
  if (nonAugment !== undefined) {
    return nonAugment.score;
  }
  return scored[0]?.score ?? RELEVANCE_TERMINATION_ABSOLUTE_FLOOR;
}
