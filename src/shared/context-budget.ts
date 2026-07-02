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

export type ContextBudgetTurnCategory = 'default' | 'temporal' | 'recall' | 'task' | 'emotional' | 'creative' | 'factual';

export interface AdaptiveContextBudgetProfile {
  enabled: boolean;
  source: 'disabled' | 'default' | 'adaptive';
  category: ContextBudgetTurnCategory;
  sessionHistoryBudgetPct: number;
  memoryRetrievalBudgetPct: number;
}

export interface AdaptiveContextBudgetPreviewProfile {
  key: 'default' | 'heartbeat_reflection' | 'temporal' | 'recall' | 'task' | 'emotional' | 'creative' | 'factual';
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

// E8.3: supplemental wiki RAG caps. Wiki context is bounded per context class
// and allocated independently of (and after) the memory budget, so wiki never
// displaces memory. The enable flag defaults OFF so live chat behavior is
// unchanged until an operator opts in; the semantic index + wiki tool search
// are always available regardless of this flag.
export const WIKI_RETRIEVAL_ENABLED_DEFAULT = false;
export const WIKI_RETRIEVAL_CHAT_TOKEN_CAP_DEFAULT = 1_000;
export const WIKI_RETRIEVAL_GROUP_TOKEN_CAP_DEFAULT = 400;
export const WIKI_RETRIEVAL_FOCUS_TOKEN_CAP_DEFAULT = 2_000;
export const WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_DEFAULT = 0.6;
export const WIKI_RETRIEVAL_GROUP_SIMILARITY_THRESHOLD_DEFAULT = 0.78;

export const WIKI_RETRIEVAL_TOKEN_CAP_RANGE = { min: 0, max: 16_000 } as const;
export const WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_RANGE = { min: 0, max: 1 } as const;

export interface WikiRetrievalSettings {
  enabled: boolean;
  chatTokenCap: number;
  groupTokenCap: number;
  focusTokenCap: number;
  similarityThreshold: number;
  groupSimilarityThreshold: number;
}

export interface WikiRetrievalConfigLike {
  wikiRetrievalEnabled?: boolean;
  wikiRetrievalChatTokenCap?: number;
  wikiRetrievalGroupTokenCap?: number;
  wikiRetrievalFocusTokenCap?: number;
  wikiRetrievalSimilarityThreshold?: number;
  wikiRetrievalGroupSimilarityThreshold?: number;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function resolveWikiRetrievalSettings(config: WikiRetrievalConfigLike): WikiRetrievalSettings {
  return {
    enabled: config.wikiRetrievalEnabled ?? WIKI_RETRIEVAL_ENABLED_DEFAULT,
    chatTokenCap: Math.floor(clampNumber(
      config.wikiRetrievalChatTokenCap,
      WIKI_RETRIEVAL_CHAT_TOKEN_CAP_DEFAULT,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.min,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.max,
    )),
    groupTokenCap: Math.floor(clampNumber(
      config.wikiRetrievalGroupTokenCap,
      WIKI_RETRIEVAL_GROUP_TOKEN_CAP_DEFAULT,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.min,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.max,
    )),
    focusTokenCap: Math.floor(clampNumber(
      config.wikiRetrievalFocusTokenCap,
      WIKI_RETRIEVAL_FOCUS_TOKEN_CAP_DEFAULT,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.min,
      WIKI_RETRIEVAL_TOKEN_CAP_RANGE.max,
    )),
    similarityThreshold: clampNumber(
      config.wikiRetrievalSimilarityThreshold,
      WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_DEFAULT,
      WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_RANGE.min,
      WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_RANGE.max,
    ),
    groupSimilarityThreshold: clampNumber(
      config.wikiRetrievalGroupSimilarityThreshold,
      WIKI_RETRIEVAL_GROUP_SIMILARITY_THRESHOLD_DEFAULT,
      WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_RANGE.min,
      WIKI_RETRIEVAL_SIMILARITY_THRESHOLD_RANGE.max,
    ),
  };
}

export const SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE = 256;
export const MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM = 170;

export const SESSION_HISTORY_MIN_MESSAGES = 5;
export const MEMORY_RETRIEVAL_MIN_ITEMS = 1;

export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 128_000;
const TASK_KIND_TASK_SET = new Set(['planning', 'maintenance', 'deferred_tool_handoff']);
const COMPANION_CONTEXT_TASK_KIND_SET = new Set(['heartbeat', 'reflection']);
const CHANNEL_TASK_TYPE_SET = new Set(['terminal', 'internal']);
const TEMPORAL_NOW_PATTERN = /\b(now|right now|current time|local time|what time(?: is it)?|what(?:'s| is) the time|time is it|time now|what day(?: is it)?|what date(?: is it)?|date(?: and time)?|current date)\b/i;
const TEMPORAL_DAY_PATTERN = /\b(today|this morning|this afternoon|this evening|tonight|earlier today|just now|this hour)\b/i;
const TEMPORAL_RECENT_HOURS_PATTERN = /\b(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?:\s+of)?|several)\s+hours?\s+ago\b/i;
const TEMPORAL_RECENT_MINUTES_PATTERN = /\b(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?:\s+of)?|several)\s+minutes?\s+ago\b/i;
const TEMPORAL_EXPLICIT_CORRECTION_PATTERN = /\b(actually|correction|correct(?:ing|ed)?|more accurately|to be precise|i meant|i mean)\b.*\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|today|tonight|this morning|this afternoon|this evening)\b/i;
const MEMORY_RECALL_PATTERN = /\b(remember|recall|memory|memories|journal|scratchpad|what do you know about|what did i (?:say|mention|tell)|last time|previous conversation)\b/i;
const TASK_PATTERN = /\b(step(?:-by-step)?|plan|roadmap|implement|fix|debug|build|refactor|investigate|analy[sz]e|tests?|deploy|terminal|shell|command|script)\b/i;
const EMOTIONAL_PATTERN = /\b(feel(?:ing)?|emotion(?:al)?|anxious|stressed|overwhelmed|upset|sad|lonely|frustrated|relationship|support|comfort|vent)\b/i;
const CREATIVE_PATTERN = /\b(write|story|poem|lyrics|brainstorm|creative|invent|imagine|character|scene|worldbuilding)\b/i;
const FACTUAL_PATTERN = /\b(what|when|where|who|which|why|how|explain|define|summarize)\b/i;
const ADAPTIVE_BUDGET_PROFILE_BY_CATEGORY: Readonly<Record<
  Exclude<ContextBudgetTurnCategory, 'default'>,
  { sessionHistoryBudgetPct: number; memoryRetrievalBudgetPct: number }
>> = {
  temporal: { sessionHistoryBudgetPct: 4, memoryRetrievalBudgetPct: 6 },
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

export interface TemporalTurnWindow {
  mode: 'same_day' | 'recent_hours';
  recentHours?: number;
}

function matchesTemporalCue(text: string): boolean {
  return TEMPORAL_NOW_PATTERN.test(text)
    || TEMPORAL_DAY_PATTERN.test(text)
    || TEMPORAL_RECENT_HOURS_PATTERN.test(text)
    || TEMPORAL_RECENT_MINUTES_PATTERN.test(text)
    || TEMPORAL_EXPLICIT_CORRECTION_PATTERN.test(text);
}

export function resolveTemporalTurnWindow(
  turn: ContextBudgetTurnCharacteristics | undefined,
): TemporalTurnWindow | null {
  const messageText = normalizeTurnText(turn?.messageText);
  if (!messageText) return null;

  if (!matchesTemporalCue(messageText)) {
    return null;
  }

  if (TEMPORAL_RECENT_HOURS_PATTERN.test(messageText)) {
    return {
      mode: 'recent_hours',
      recentHours: 12,
    };
  }

  if (TEMPORAL_RECENT_MINUTES_PATTERN.test(messageText)) {
    return {
      mode: 'recent_hours',
      recentHours: 6,
    };
  }

  return {
    mode: 'same_day',
  };
}

export function isTemporalContextBudgetTurn(
  turn: ContextBudgetTurnCharacteristics | undefined,
): boolean {
  return resolveTemporalTurnWindow(turn) !== null;
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

  if (EMOTIONAL_PATTERN.test(messageText)) {
    return 'emotional';
  }
  if (resolveTemporalTurnWindow(turn)) {
    return 'temporal';
  }
  if (MEMORY_RECALL_PATTERN.test(messageText)) {
    return 'recall';
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
    buildProfile('temporal', 'Temporal grounding', 'temporal'),
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
