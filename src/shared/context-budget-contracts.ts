export interface ModelContextBudgetConfig {
  sessionHistoryMinTokens?: number;
  memoryRetrievalMinTokens?: number;
}

export interface ContextBudgetModelSlotLike {
  model?: string;
  provider?: string;
  maxTokens?: number;
  contextWindow?: number;
  contextBudget?: ModelContextBudgetConfig;
}

export interface ContextBudgetModelCatalogEntryLike {
  model: string;
  provider: string;
  defaults?: ContextBudgetModelSlotLike;
  overrides?: ContextBudgetModelSlotLike;
}

export interface ContextBudgetModelSelectionLike {
  purpose?: string;
  slotKey?: string;
  provider?: string;
  model?: string;
  contextWindow?: number;
}
