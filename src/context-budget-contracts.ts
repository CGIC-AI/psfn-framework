export interface ModelContextBudgetConfig {
  sessionHistoryMinTokens?: number;
  memoryRetrievalMinTokens?: number;
}

export interface ContextBudgetModelSlotLike {
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
}
