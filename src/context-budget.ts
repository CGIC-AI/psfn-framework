import type {
  ContextBudgetModelCatalogEntryLike,
  ContextBudgetModelSelectionLike,
  ContextBudgetModelSlotLike,
} from './context-budget-contracts.js';

export interface ContextBudgetConfigLike {
  defaultContextWindow: number;
  modelRoster: Partial<Record<string, ContextBudgetModelSlotLike>>;
  modelCatalog?: Record<string, ContextBudgetModelCatalogEntryLike>;
  modelRoleAssignments?: Record<string, string>;
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
  modelSelection?: ContextBudgetModelSelectionLike;
}

export type ContextBudgetTurnCategory = 'default' | 'recall' | 'task' | 'emotional' | 'creative' | 'factual';

export interface AdaptiveContextBudgetProfile {
  enabled: boolean;
  source: 'disabled' | 'default' | 'adaptive';
  category: ContextBudgetTurnCategory;
  sessionHistoryBudgetPct: number;
  memoryRetrievalBudgetPct: number;
}

export interface AdaptiveContextBudgetPreviewProfile {
  key: 'default' | 'heartbeat_reflection' | 'recall' | 'task' | 'emotional' | 'creative' | 'factual';
  label: string;
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
export const MEMORY_RETRIEVAL_MIN_ITEMS = 1;

export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 128_000;
const TASK_KIND_TASK_SET = new Set(['planning', 'maintenance', 'deferred_tool_handoff']);
const COMPANION_CONTEXT_TASK_KIND_SET = new Set(['heartbeat', 'reflection']);
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

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProvider(value: unknown): string | undefined {
  return normalizeNonEmptyString(value)?.toLowerCase();
}

function normalizeModelId(value: unknown): string | undefined {
  return normalizeNonEmptyString(value);
}

function normalizeModelPurpose(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return undefined;

  switch (normalized.toLowerCase()) {
    case 'longcontext':
    case 'long_context':
      return 'longContext';
    case 'importprocessing':
    case 'import-processing':
      return 'import_processing';
    default:
      return normalized;
  }
}

function normalizeTurnText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function isCompanionContextBudgetTurn(
  turn: ContextBudgetTurnCharacteristics | undefined,
): boolean {
  const taskKind = turn?.taskKind?.trim().toLowerCase();
  if (taskKind && COMPANION_CONTEXT_TASK_KIND_SET.has(taskKind)) {
    return true;
  }

  const channelId = turn?.channelId?.trim().toLowerCase() ?? '';
  return channelId === 'internal:heartbeat'
    || channelId.startsWith('internal:heartbeat:')
    || channelId.startsWith('internal:reflection:');
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
): number {
  const rough = Math.floor(tokenBudget / Math.max(1, tokensPerItem));
  return Math.max(minCount, rough);
}

function resolvePurposeChain(purpose: string | undefined): string[] {
  switch (purpose) {
    case 'context':
      return ['longContext', 'background', 'extraction', 'chat'];
    case 'background':
      return ['background', 'extraction', 'chat'];
    case 'extraction':
      return ['extraction', 'background', 'chat'];
    case 'summary':
      return ['summary', 'background', 'chat'];
    case 'reasoning':
      return ['reasoning', 'chat'];
    case 'import_processing':
      return ['import_processing', 'extraction', 'background', 'chat'];
    case 'longContext':
      return ['longContext', 'background', 'chat'];
    case 'vision':
      return ['vision', 'chat'];
    case 'moa':
      return ['moa', 'chat'];
    case 'chat':
    case undefined:
      return ['chat'];
    default:
      return [purpose, 'chat'];
  }
}

function modelSlotFromCatalogEntry(entry: ContextBudgetModelCatalogEntryLike | undefined): ContextBudgetModelSlotLike | undefined {
  if (!entry) return undefined;

  const maxTokens = toPositiveInteger(entry.overrides?.maxTokens)
    ?? toPositiveInteger(entry.defaults?.maxTokens);
  const contextWindow = toPositiveInteger(entry.overrides?.contextWindow)
    ?? toPositiveInteger(entry.defaults?.contextWindow);
  const contextBudget = entry.overrides?.contextBudget
    ?? entry.defaults?.contextBudget;

  return {
    ...(normalizeModelId(entry.model) ? { model: entry.model } : {}),
    ...(normalizeProvider(entry.provider) ? { provider: entry.provider.trim().toLowerCase() } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextBudget !== undefined ? { contextBudget } : {}),
  };
}

function matchesCatalogEntryByProviderModel(
  entry: ContextBudgetModelCatalogEntryLike | undefined,
  provider: string | undefined,
  model: string | undefined,
): boolean {
  const entryProvider = normalizeProvider(entry?.provider);
  const entryModel = normalizeModelId(entry?.model);
  return entryProvider !== undefined
    && entryModel !== undefined
    && provider !== undefined
    && model !== undefined
    && entryProvider === provider
    && entryModel === model;
}

function resolveModelRosterSlot(
  modelRoster: Partial<Record<string, ContextBudgetModelSlotLike>>,
  purpose: string | undefined,
): ContextBudgetModelSlotLike | undefined {
  for (const candidate of resolvePurposeChain(purpose)) {
    const slot = modelRoster[candidate];
    if (slot) return slot;
  }
  return modelRoster.chat;
}

function resolveCatalogSlotKey(
  catalog: Record<string, ContextBudgetModelCatalogEntryLike>,
  assignments: Record<string, string> | undefined,
  purpose: string | undefined,
): string | undefined {
  for (const candidate of resolvePurposeChain(purpose)) {
    const slotKey = assignments?.[candidate];
    if (slotKey && Object.hasOwn(catalog, slotKey)) return slotKey;
    if (Object.hasOwn(catalog, candidate)) return candidate;
  }
  return undefined;
}

export function resolveContextBudgetModelSlot(
  config: Pick<
    ContextBudgetConfigLike,
    'defaultContextWindow' | 'modelRoster' | 'modelCatalog' | 'modelRoleAssignments'
  >,
  options: Pick<ContextBudgetResolutionOptions, 'turn'> = {},
): ContextBudgetModelSlotLike {
  const selection = options.turn?.modelSelection;
  const normalizedPurpose = normalizeModelPurpose(selection?.purpose) ?? 'chat';
  const catalog = config.modelCatalog ?? {};
  const assignedSlotKey = resolveCatalogSlotKey(catalog, config.modelRoleAssignments, normalizedPurpose);
  const assignedEntry = assignedSlotKey ? catalog[assignedSlotKey] : undefined;
  const normalizedProvider = normalizeProvider(selection?.provider);
  const normalizedModel = normalizeModelId(selection?.model);

  let resolvedSlot = modelSlotFromCatalogEntry(
    selection?.slotKey ? catalog[selection.slotKey] : undefined,
  );
  if (!resolvedSlot && normalizedProvider && normalizedModel) {
    if (matchesCatalogEntryByProviderModel(assignedEntry, normalizedProvider, normalizedModel)) {
      resolvedSlot = modelSlotFromCatalogEntry(assignedEntry);
    }
    if (!resolvedSlot) {
      const matchingEntry = Object.values(catalog).find(entry => (
        matchesCatalogEntryByProviderModel(entry, normalizedProvider, normalizedModel)
      ));
      resolvedSlot = modelSlotFromCatalogEntry(matchingEntry);
    }
  }
  if (!resolvedSlot) {
    resolvedSlot = modelSlotFromCatalogEntry(assignedEntry)
      ?? resolveModelRosterSlot(config.modelRoster, normalizedPurpose);
  }

  const contextWindow = toPositiveInteger(selection?.contextWindow);
  return {
    ...(resolvedSlot ?? {}),
    ...(normalizedProvider !== undefined ? { provider: normalizedProvider } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

export function resolveChatContextWindow(
  config: Pick<
    ContextBudgetConfigLike,
    'defaultContextWindow' | 'modelRoster' | 'modelCatalog' | 'modelRoleAssignments'
  >,
  options: Pick<ContextBudgetResolutionOptions, 'turn'> = {},
): number {
  const resolvedSlot = resolveContextBudgetModelSlot(config, options);
  const fromResolvedSlot = toPositiveInteger(resolvedSlot.contextWindow);
  if (fromResolvedSlot !== undefined) return fromResolvedSlot;
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
  const channelType = turn?.channelType?.trim().toLowerCase();
  const channelId = turn?.channelId?.trim().toLowerCase() ?? '';
  if (!isCompanionContextBudgetTurn(turn)) {
    if (taskKind && TASK_KIND_TASK_SET.has(taskKind)) {
      return 'task';
    }

    if (channelType && CHANNEL_TASK_TYPE_SET.has(channelType)) {
      return 'task';
    }

    if (channelId.startsWith('internal:') || channelId.startsWith('terminal:')) {
      return 'task';
    }
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

export function resolveAdaptiveContextBudgetPreviewProfiles(
  config: Pick<
    ContextBudgetConfigLike,
    'sessionHistoryBudgetPct' | 'memoryRetrievalBudgetPct' | 'adaptiveContextBudgetsEnabled'
  >,
): AdaptiveContextBudgetPreviewProfile[] {
  const baseProfile = resolveAdaptiveContextBudgetProfile(config);
  const buildProfile = (
    key: AdaptiveContextBudgetPreviewProfile['key'],
    label: string,
    category: ContextBudgetTurnCategory,
  ): AdaptiveContextBudgetPreviewProfile => {
    if (category === 'default') {
      return {
        key,
        label,
        source: baseProfile.source,
        category,
        sessionHistoryBudgetPct: baseProfile.sessionHistoryBudgetPct,
        memoryRetrievalBudgetPct: baseProfile.memoryRetrievalBudgetPct,
      };
    }

    if (config.adaptiveContextBudgetsEnabled !== true) {
      return {
        key,
        label,
        source: 'disabled',
        category,
        sessionHistoryBudgetPct: baseProfile.sessionHistoryBudgetPct,
        memoryRetrievalBudgetPct: baseProfile.memoryRetrievalBudgetPct,
      };
    }

    const adaptiveProfile = ADAPTIVE_BUDGET_PROFILE_BY_CATEGORY[category];
    return {
      key,
      label,
      source: 'adaptive',
      category,
      sessionHistoryBudgetPct: clamp(
        adaptiveProfile.sessionHistoryBudgetPct,
        SESSION_HISTORY_BUDGET_PCT_RANGE.min,
        SESSION_HISTORY_BUDGET_PCT_RANGE.max,
      ),
      memoryRetrievalBudgetPct: clamp(
        adaptiveProfile.memoryRetrievalBudgetPct,
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
      ),
    };
  };

  return [
    buildProfile('default', 'Default chat', 'default'),
    buildProfile('heartbeat_reflection', 'Heartbeat / reflection', 'default'),
    buildProfile('recall', 'Memory recall', 'recall'),
    buildProfile('task', 'Task / terminal', 'task'),
    buildProfile('emotional', 'Emotional support', 'emotional'),
    buildProfile('creative', 'Creative work', 'creative'),
    buildProfile('factual', 'Factual Q&A', 'factual'),
  ];
}

export function resolveSessionHistoryBudget(
  config: ContextBudgetConfigLike,
  options: ContextBudgetResolutionOptions = {},
): ResolvedContextBudget {
  const resolvedSlot = resolveContextBudgetModelSlot(config, options);
  const contextWindow = toPositiveInteger(resolvedSlot.contextWindow)
    ?? toPositiveInteger(config.defaultContextWindow)
    ?? DEFAULT_CONTEXT_WINDOW_FALLBACK;
  const adaptiveProfile = options.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(config, options.turn);
  const budgetPct = adaptiveProfile.sessionHistoryBudgetPct;
  const minTokenFloor = resolveTokenFloor(
    resolvedSlot.contextBudget?.sessionHistoryMinTokens,
    SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT,
    contextWindow,
  );
  const tokenBudget = Math.max(minTokenFloor, Math.floor(contextWindow * (budgetPct / 100)));
  const estimatedCount = estimateCountFromBudget(
    tokenBudget,
    SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
    SESSION_HISTORY_MIN_MESSAGES,
  );

  return {
    contextWindow,
    budgetPct,
    tokenBudget,
    estimatedCount,
    mode: 'budget',
  };
}

export function resolveMemoryRetrievalBudget(
  config: ContextBudgetConfigLike,
  options: ContextBudgetResolutionOptions = {},
): ResolvedContextBudget {
  const resolvedSlot = resolveContextBudgetModelSlot(config, options);
  const contextWindow = toPositiveInteger(resolvedSlot.contextWindow)
    ?? toPositiveInteger(config.defaultContextWindow)
    ?? DEFAULT_CONTEXT_WINDOW_FALLBACK;
  const adaptiveProfile = options.adaptiveProfile ?? resolveAdaptiveContextBudgetProfile(config, options.turn);
  const budgetPct = adaptiveProfile.memoryRetrievalBudgetPct;
  const minTokenFloor = resolveTokenFloor(
    resolvedSlot.contextBudget?.memoryRetrievalMinTokens,
    MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT,
    contextWindow,
  );
  const tokenBudget = Math.max(minTokenFloor, Math.floor(contextWindow * (budgetPct / 100)));
  const estimatedCount = estimateCountFromBudget(
    tokenBudget,
    MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM,
    MEMORY_RETRIEVAL_MIN_ITEMS,
  );

  return {
    contextWindow,
    budgetPct,
    tokenBudget,
    estimatedCount,
    mode: 'budget',
  };
}
