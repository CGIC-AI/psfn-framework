import type { ContextBudgetModelSlotLike } from './context-budget-contracts.js';

export interface ContextBudgetConfigLike {
  defaultContextWindow: number;
  modelRoster: Partial<Record<'chat', ContextBudgetModelSlotLike>>;
  sessionMessageLimit?: number;
  memoryRetrievalLimit?: number;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
}

export interface PercentageRange {
  min: number;
  max: number;
}

export interface ResolvedContextBudget {
  contextWindow: number;
  budgetPct: number;
  tokenBudget: number;
  estimatedCount: number;
  hardLimit?: number;
  mode: 'budget' | 'hard_limit';
}

export const SESSION_HISTORY_BUDGET_PCT_DEFAULT = 6;
export const MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT = 2;
export const SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT = 4_000;
export const MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT = 1_000;

export const SESSION_HISTORY_BUDGET_PCT_RANGE: PercentageRange = { min: 1, max: 80 };
export const MEMORY_RETRIEVAL_BUDGET_PCT_RANGE: PercentageRange = { min: 1, max: 50 };

export const SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE = 256;
export const MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM = 170;

export const SESSION_HISTORY_MIN_MESSAGES = 5;
export const SESSION_HISTORY_MAX_MESSAGES = 400;
export const MEMORY_RETRIEVAL_MIN_ITEMS = 1;
export const MEMORY_RETRIEVAL_MAX_ITEMS = 200;

const DEFAULT_CONTEXT_WINDOW_FALLBACK = 128_000;

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolvePct(value: number | undefined, fallback: number, range: PercentageRange): number {
  const normalized = toPositiveInteger(value);
  if (normalized === undefined) return fallback;
  return clamp(normalized, range.min, range.max);
}

function resolveTokenFloor(
  value: number | undefined,
  fallback: number,
  contextWindow: number,
): number {
  const normalized = toPositiveInteger(value) ?? fallback;
  return clamp(normalized, 1, contextWindow);
}

function estimateCountFromBudget(
  tokenBudget: number,
  tokensPerItem: number,
  minCount: number,
  maxCount: number,
): number {
  const rough = Math.floor(tokenBudget / Math.max(1, tokensPerItem));
  return clamp(rough, minCount, maxCount);
}

export function resolveChatContextWindow(config: Pick<ContextBudgetConfigLike, 'defaultContextWindow' | 'modelRoster'>): number {
  const fromChatSlot = toPositiveInteger(config.modelRoster.chat?.contextWindow);
  if (fromChatSlot !== undefined) return fromChatSlot;
  return toPositiveInteger(config.defaultContextWindow) ?? DEFAULT_CONTEXT_WINDOW_FALLBACK;
}

export function resolveSessionHistoryBudgetPct(
  config: Pick<ContextBudgetConfigLike, 'sessionHistoryBudgetPct'>,
): number {
  return resolvePct(
    config.sessionHistoryBudgetPct,
    SESSION_HISTORY_BUDGET_PCT_DEFAULT,
    SESSION_HISTORY_BUDGET_PCT_RANGE,
  );
}

export function resolveMemoryRetrievalBudgetPct(
  config: Pick<ContextBudgetConfigLike, 'memoryRetrievalBudgetPct'>,
): number {
  return resolvePct(
    config.memoryRetrievalBudgetPct,
    MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  );
}

export function resolveSessionHistoryBudget(config: ContextBudgetConfigLike): ResolvedContextBudget {
  const hardLimit = toPositiveInteger(config.sessionMessageLimit);
  const contextWindow = resolveChatContextWindow(config);
  const budgetPct = resolveSessionHistoryBudgetPct(config);
  const minTokenFloor = resolveTokenFloor(
    config.modelRoster.chat?.contextBudget?.sessionHistoryMinTokens,
    SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT,
    contextWindow,
  );
  const tokenBudget = Math.max(minTokenFloor, Math.floor(contextWindow * (budgetPct / 100)));
  const estimatedCount = hardLimit ?? estimateCountFromBudget(
    tokenBudget,
    SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
    SESSION_HISTORY_MIN_MESSAGES,
    SESSION_HISTORY_MAX_MESSAGES,
  );

  return {
    contextWindow,
    budgetPct,
    tokenBudget,
    estimatedCount,
    ...(hardLimit !== undefined ? { hardLimit } : {}),
    mode: hardLimit !== undefined ? 'hard_limit' : 'budget',
  };
}

export function resolveMemoryRetrievalBudget(config: ContextBudgetConfigLike): ResolvedContextBudget {
  const hardLimit = toPositiveInteger(config.memoryRetrievalLimit);
  const contextWindow = resolveChatContextWindow(config);
  const budgetPct = resolveMemoryRetrievalBudgetPct(config);
  const minTokenFloor = resolveTokenFloor(
    config.modelRoster.chat?.contextBudget?.memoryRetrievalMinTokens,
    MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT,
    contextWindow,
  );
  const tokenBudget = Math.max(minTokenFloor, Math.floor(contextWindow * (budgetPct / 100)));
  const estimatedCount = hardLimit ?? estimateCountFromBudget(
    tokenBudget,
    MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM,
    MEMORY_RETRIEVAL_MIN_ITEMS,
    MEMORY_RETRIEVAL_MAX_ITEMS,
  );

  return {
    contextWindow,
    budgetPct,
    tokenBudget,
    estimatedCount,
    ...(hardLimit !== undefined ? { hardLimit } : {}),
    mode: hardLimit !== undefined ? 'hard_limit' : 'budget',
  };
}
