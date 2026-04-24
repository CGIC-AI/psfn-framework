import { countTokens } from '../../../primitives/llm/tokens.js';
import {
  MEMORY_RETRIEVAL_MIN_ITEMS,
} from '../../../shared/context-budget.js';
import type { PurrMemory } from '../types.js';
import { SCORE_GUARANTEE_MIN_K } from './scoring.js';
import type {
  RetrievalSelectionDecision,
  ScoredMemory,
} from './types.js';

const RELEVANCE_TERMINATION_ABSOLUTE_FLOOR = 0.12;
const RELEVANCE_TERMINATION_RELATIVE_FLOOR = 0.25;

function estimateMemoryPromptTokens(memory: PurrMemory): number {
  return Math.max(1, countTokens(`[${memory.type}] ${memory.text}`));
}

export function resolveGuaranteedSelectionFloor(
  rankedLength: number,
  scoreGuaranteedCount: number,
): number {
  if (scoreGuaranteedCount > 0) {
    return Math.min(rankedLength, Math.max(MEMORY_RETRIEVAL_MIN_ITEMS, SCORE_GUARANTEE_MIN_K));
  }
  return Math.min(rankedLength, MEMORY_RETRIEVAL_MIN_ITEMS);
}

export function selectWithinRelevanceAndTokenBudget(
  scored: ScoredMemory[],
  tokenBudget: number,
  minimumSelectedCount = MEMORY_RETRIEVAL_MIN_ITEMS,
): RetrievalSelectionDecision {
  const selectionFloor = Math.max(1, Math.min(minimumSelectedCount, scored.length));

  if (scored.length === 0) {
    return {
      selected: [],
      stopReason: 'exhausted',
      relevanceStoppedCount: 0,
      budgetCappedCount: 0,
      relevanceScoreFloor: RELEVANCE_TERMINATION_ABSOLUTE_FLOOR,
    };
  }

  if (tokenBudget <= 0) {
    const selected = scored.slice(0, selectionFloor);
    return {
      selected,
      stopReason: scored.length > selected.length ? 'budget' : 'exhausted',
      relevanceStoppedCount: 0,
      budgetCappedCount: Math.max(0, scored.length - selected.length),
      relevanceScoreFloor: Math.max(
        RELEVANCE_TERMINATION_ABSOLUTE_FLOOR,
        scored[0].score * RELEVANCE_TERMINATION_RELATIVE_FLOOR,
      ),
    };
  }

  const relevanceScoreFloor = Math.max(
    RELEVANCE_TERMINATION_ABSOLUTE_FLOOR,
    scored[0].score * RELEVANCE_TERMINATION_RELATIVE_FLOOR,
  );
  let usedTokens = 0;
  const selected: ScoredMemory[] = [];
  let stopReason: RetrievalSelectionDecision['stopReason'] = 'exhausted';
  let relevanceStoppedCount = 0;
  let budgetCappedCount = 0;

  for (let index = 0; index < scored.length; index++) {
    const item = scored[index];
    const itemTokens = estimateMemoryPromptTokens(item.memory);

    if (selected.length >= selectionFloor) {
      if (item.score < relevanceScoreFloor) {
        stopReason = 'relevance';
        relevanceStoppedCount = scored.length - index;
        break;
      }

      if (usedTokens + itemTokens > tokenBudget) {
        stopReason = 'budget';
        budgetCappedCount = scored.length - index;
        break;
      }
    }

    selected.push(item);
    usedTokens += itemTokens;
  }

  return {
    selected,
    stopReason,
    relevanceStoppedCount,
    budgetCappedCount,
    relevanceScoreFloor,
  };
}
