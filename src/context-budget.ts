import type { ContextBudgetModelSlotLike } from './context-budget-contracts.js';

export interface ContextBudgetConfigLike {
  defaultContextWindow: number;
  modelRoster: Partial<Record<'chat', ContextBudgetModelSlotLike>>;
  sessionMessageLimit?: number;
  memoryRetrievalLimit?: number;
  sessionHistoryBudgetPct?: number;
  memoryRetrievalBudgetPct?: number;
  adaptiveContextBudgetsEnabled?: boolean;
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

export interface ContextBudgetTurnCharacteristics {
  channelId?: string;
  channelType?: string;
  isDirectMessage?: boolean;
  messageText?: string;
  taskKind?: string;
}

export type ContextBudgetTurnCategory = 'default' | 'recall' | 'task' | 'emotional' | 'creative' | 'factual';

export interface AdaptiveContextBudgetProfile {
  enabled: boolean;
  source: 'disabled' | 'default' | 'adaptive';
  category: ContextBudgetTurnCategory;
  sessionHistoryBudgetPct: number;
  memoryRetrievalBudgetPct: number;
}

export interface ContextBudgetResolutionOptions {
  turn?: ContextBudgetTurnCharacteristics;
  adaptiveProfile?: AdaptiveContextBudgetProfile;
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
const TASK_KIND_TASK_SET = new Set(['heartbeat', 'reflection', 'planning', 'maintenance', 'deferred_tool_handoff']);
const CHANNEL_TASK_TYPE_SET = new Set(['terminal', 'internal']);
const MEMORY_RECALL_PATTERN = /\b(remember|recall|memory|memories|journal|scratchpad|what do you know about|what did i (?:say|mention|tell)|last time|previous conversation)\b/i;
const TASK_PATTERN = /\b(step(?:-by-step)?|plan|roadmap|implement|fix|debug|build|refactor|investigate|analy[sz]e|tests?|deploy|terminal|shell|command|script)\b/i;
const EMOTIONAL_PATTERN = /\b(feel(?:ing)?|emotion(?:al)?|anxious|stressed|overwhelmed|upset|sad|lonely|frustrated|relationship|support|comfort|vent)\b/i;
const CREATIVE_PATTERN = /\b(write|story|poem|lyrics|brainstorm|creative|invent|imagine|character|scene|worldbuilding)\b/i;
const FACTUAL_PATTERN = /\b(what|when|where|who|which|why|how|explain|define|summarize)\b/i;
const ADAPTIVE_BUDGET_PROFILE_BY_CATEGORY: Readonly<Record<
  Exclude<ContextBudgetTurnCategory, 'default'>,
  { sessionHistoryBudgetPct: number; memoryRetrievalBudgetPct: number }
>> = {
  recall: { sessionHistoryBudgetPct: 4, memoryRetrievalBudgetPct: 8 },
  task: { sessionHistoryBudgetPct: 12, memoryRetrievalBudgetPct: 2 },
  emotional: { sessionHistoryBudgetPct: 7, memoryRetrievalBudgetPct: 4 },
  creative: { sessionHistoryBudgetPct: 9, memoryRetrievalBudgetPct: 3 },
  factual: { sessionHistoryBudgetPct: 6, memoryRetrievalBudgetPct: 3 },
};

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeTurnText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
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

export function classifyContextBudgetTurn(
  turn: ContextBudgetTurnCharacteristics | undefined,
): ContextBudgetTurnCategory {
  const taskKind = turn?.taskKind?.trim().toLowerCase();
  if (taskKind && TASK_KIND_TASK_SET.has(taskKind)) {
    return 'task';
  }

  const channelType = turn?.channelType?.trim().toLowerCase();
  if (channelType && CHANNEL_TASK_TYPE_SET.has(channelType)) {
    return 'task';
  }

  const channelId = turn?.channelId?.trim().toLowerCase() ?? '';
  if (channelId.startsWith('internal:') || channelId.startsWith('terminal:')) {
    return 'task';
  }

  const messageText = normalizeTurnText(turn?.messageText);
  if (!messageText) {
    return 'default';
  }

  if (MEMORY_RECALL_PATTERN.test(messageText)) {
    return 'recall';
  }
  if (EMOTIONAL_PATTERN.test(messageText)) {
    return 'emotional';
  }
  if (CREATIVE_PATTERN.test(messageText)) {
    return 'creative';
  }
  if (TASK_PATTERN.test(messageText) || messageText.includes('```')) {
    return 'task';
  }
  if (FACTUAL_PATTERN.test(messageText) && messageText.includes('?')) {
    return 'factual';
  }

  return 'default';
}

export function resolveAdaptiveContextBudgetProfile(
  config: Pick<
    ContextBudgetConfigLike,
    'sessionHistoryBudgetPct' | 'memoryRetrievalBudgetPct' | 'adaptiveContextBudgetsEnabled'
  >,
  turn?: ContextBudgetTurnCharacteristics,
): AdaptiveContextBudgetProfile {
  const baseSessionHistoryPct = resolveSessionHistoryBudgetPct(config);
  const baseMemoryRetrievalPct = resolveMemoryRetrievalBudgetPct(config);

  if (config.adaptiveContextBudgetsEnabled !== true) {
    return {
      enabled: false,
      source: 'disabled',
      category: 'default',
      sessionHistoryBudgetPct: baseSessionHistoryPct,
      memoryRetrievalBudgetPct: baseMemoryRetrievalPct,
    };
  }

  const category = classifyContextBudgetTurn(turn);
  if (category === 'default') {
    return {
      enabled: true,
      source: 'default',
      category,
      sessionHistoryBudgetPct: baseSessionHistoryPct,
      memoryRetrievalBudgetPct: baseMemoryRetrievalPct,
    };
  }

  const profile = ADAPTIVE_BUDGET_PROFILE_BY_CATEGORY[category];

  return {
    enabled: true,
    source: 'adaptive',
    category,
    sessionHistoryBudgetPct: clamp(
      profile.sessionHistoryBudgetPct,
      SESSION_HISTORY_BUDGET_PCT_RANGE.min,
      SESSION_HISTORY_BUDGET_PCT_RANGE.max,
    ),
    memoryRetrievalBudgetPct: clamp(
      profile.memoryRetrievalBudgetPct,
      MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
      MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
    ),
  };
}

export function resolveSessionHistoryBudget(
  config: ContextBudgetConfigLike,
  options: ContextBudgetResolutionOptions = {},
): ResolvedContextBudget {
  const hardLimit = toPositiveInteger(config.sessionMessageLimit);
  const contextWindow = resolveChatContextWindow(config);
  const adaptiveProfile = options.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(config, options.turn);
  const budgetPct = adaptiveProfile.sessionHistoryBudgetPct;
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

export function resolveMemoryRetrievalBudget(
  config: ContextBudgetConfigLike,
  options: ContextBudgetResolutionOptions = {},
): ResolvedContextBudget {
  const hardLimit = toPositiveInteger(config.memoryRetrievalLimit);
  const contextWindow = resolveChatContextWindow(config);
  const adaptiveProfile = options.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(config, options.turn);
  const budgetPct = adaptiveProfile.memoryRetrievalBudgetPct;
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
