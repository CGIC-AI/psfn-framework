import {
  MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM,
  resolveAdaptiveContextBudgetPreviewProfiles,
  resolveChatContextWindow,
  resolveContextBudgetModelSlot,
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
  type AdaptiveContextBudgetPreviewProfile,
  type ContextBudgetConfigLike,
  type ResolvedContextBudget,
} from '../../../../src/shared/context-budget.js';

export interface ContextBudgetPreviewVariant {
  key: AdaptiveContextBudgetPreviewProfile['key'];
  label: string;
  source: AdaptiveContextBudgetPreviewProfile['source'];
  category: AdaptiveContextBudgetPreviewProfile['category'];
  sessionBudget: ResolvedContextBudget;
  memoryBudget: ResolvedContextBudget;
}

export interface ContextBudgetPreviewData {
  contextWindow: number;
  systemPromptTokens: number;
  maxResponseTokens: number;
  resolvedChatModel?: string;
  resolvedChatProvider?: string;
  sessionHistoryMinTokens?: number;
  memoryRetrievalMinTokens?: number;
  sessEstimatedCount: number;
  sessEstimatedTokens: number;
  sessTokenBudget: number;
  memEstimatedCount: number;
  memEstimatedTokens: number;
  memTokenBudget: number;
  allocated: number;
  remaining: number;
  sysPct: number;
  sessPct: number;
  memPct: number;
  respPct: number;
  remainPct: number;
  variants: ContextBudgetPreviewVariant[];
}

export function buildContextBudgetPreview(
  config: ContextBudgetConfigLike,
  options: {
    systemPromptTokens: number;
    maxResponseTokens: number;
  },
): ContextBudgetPreviewData {
  const chatTurn = {
    modelSelection: {
      purpose: 'chat',
    },
  } as const;
  const resolvedSlot = resolveContextBudgetModelSlot(config, { turn: chatTurn });
  const contextWindow = resolveChatContextWindow(config, { turn: chatTurn });
  const previewProfiles = resolveAdaptiveContextBudgetPreviewProfiles(config);
  const variants = previewProfiles.map((profile): ContextBudgetPreviewVariant => {
    const adaptiveProfile = {
      enabled: config.adaptiveContextBudgetsEnabled === true,
      source: profile.source,
      category: profile.category,
      sessionHistoryBudgetPct: profile.sessionHistoryBudgetPct,
      memoryRetrievalBudgetPct: profile.memoryRetrievalBudgetPct,
    } as const;

    return {
      key: profile.key,
      label: profile.label,
      source: profile.source,
      category: profile.category,
      sessionBudget: resolveSessionHistoryBudget(config, {
        turn: chatTurn,
        adaptiveProfile,
      }),
      memoryBudget: resolveMemoryRetrievalBudget(config, {
        turn: chatTurn,
        adaptiveProfile,
      }),
    };
  });
  const activeVariant = variants[0];
  const sessEstimatedTokens = activeVariant.sessionBudget.estimatedCount * SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE;
  const memEstimatedTokens = activeVariant.memoryBudget.estimatedCount * MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM;
  const allocated = options.systemPromptTokens + sessEstimatedTokens + memEstimatedTokens + options.maxResponseTokens;
  const remaining = contextWindow - allocated;

  return {
    contextWindow,
    systemPromptTokens: options.systemPromptTokens,
    maxResponseTokens: options.maxResponseTokens,
    ...(resolvedSlot.model ? { resolvedChatModel: resolvedSlot.model } : {}),
    ...(resolvedSlot.provider ? { resolvedChatProvider: resolvedSlot.provider } : {}),
    ...(resolvedSlot.contextBudget?.sessionHistoryMinTokens !== undefined
      ? { sessionHistoryMinTokens: resolvedSlot.contextBudget.sessionHistoryMinTokens }
      : {}),
    ...(resolvedSlot.contextBudget?.memoryRetrievalMinTokens !== undefined
      ? { memoryRetrievalMinTokens: resolvedSlot.contextBudget.memoryRetrievalMinTokens }
      : {}),
    sessEstimatedCount: activeVariant.sessionBudget.estimatedCount,
    sessEstimatedTokens,
    sessTokenBudget: activeVariant.sessionBudget.tokenBudget,
    memEstimatedCount: activeVariant.memoryBudget.estimatedCount,
    memEstimatedTokens,
    memTokenBudget: activeVariant.memoryBudget.tokenBudget,
    allocated,
    remaining,
    sysPct: (options.systemPromptTokens / contextWindow) * 100,
    sessPct: (sessEstimatedTokens / contextWindow) * 100,
    memPct: (memEstimatedTokens / contextWindow) * 100,
    respPct: (options.maxResponseTokens / contextWindow) * 100,
    remainPct: (Math.max(0, remaining) / contextWindow) * 100,
    variants,
  };
}
