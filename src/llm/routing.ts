import type {
  ModelCatalogEntry,
  ModelRoleAssignments,
  ModelSlot,
  SubstrateConfig,
} from '../types.js';

export type RoutingPurpose = 'chat' | 'background' | 'reasoning';

export interface RoutingCandidate {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  slotKey?: string;
}

function uniquePush(
  target: RoutingCandidate[],
  candidate: RoutingCandidate | undefined,
  seen: Set<string>,
): void {
  if (!candidate) return;
  const key = `${candidate.provider}::${candidate.model}::${candidate.maxTokens}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(candidate);
}

function fallbackTokenBudget(config: SubstrateConfig, purpose: RoutingPurpose): { maxTokens: number; contextWindow?: number } {
  if (purpose === 'background') {
    return { maxTokens: config.extractionMaxTokens };
  }
  const chatWindow = config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow;
  return { maxTokens: config.primaryMaxTokens, contextWindow: chatWindow };
}

function candidateFromCatalogEntry(
  slotKey: string,
  entry: ModelCatalogEntry,
  fallback: { maxTokens: number; contextWindow?: number },
): RoutingCandidate | undefined {
  const maxTokens = entry.overrides?.maxTokens
    ?? entry.defaults?.maxTokens
    ?? fallback.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return undefined;

  const contextWindow = entry.overrides?.contextWindow
    ?? entry.defaults?.contextWindow
    ?? fallback.contextWindow;

  return {
    slotKey,
    model: entry.model,
    provider: entry.provider,
    maxTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function candidateFromRosterSlot(slot: ModelSlot | undefined): RoutingCandidate | undefined {
  if (!slot) return undefined;
  if (!slot.model || !slot.provider || !Number.isFinite(slot.maxTokens) || slot.maxTokens <= 0) return undefined;
  return {
    model: slot.model,
    provider: slot.provider,
    maxTokens: slot.maxTokens,
    ...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
  };
}

function purposeSlotChain(assignments: ModelRoleAssignments | undefined, purpose: RoutingPurpose): string[] {
  const role = assignments ?? {};
  const chain = purpose === 'chat'
    ? [
      role.chat,
      'primary',
      role.reasoning,
      role.summary,
    ]
    : purpose === 'background'
      ? [
        role.background,
        role.chat,
        'primary',
        role.extraction,
        'extraction',
      ]
      : [
        role.reasoning,
        role.chat,
        'primary',
        role.background,
        role.extraction,
        'extraction',
      ];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of chain) {
    if (!candidate) continue;
    const slotKey = candidate.trim();
    if (!slotKey || seen.has(slotKey)) continue;
    seen.add(slotKey);
    deduped.push(slotKey);
  }
  return deduped;
}

function rosterChain(config: SubstrateConfig, purpose: RoutingPurpose): Array<ModelSlot | undefined> {
  if (purpose === 'chat') {
    return [
      config.modelRoster.chat,
      {
        model: config.primaryModel,
        provider: config.primaryProvider,
        maxTokens: config.primaryMaxTokens,
        contextWindow: config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow,
      },
      config.modelRoster.background,
    ];
  }

  if (purpose === 'background') {
    return [
      config.modelRoster.background,
      config.modelRoster.chat,
      {
        model: config.primaryModel,
        provider: config.primaryProvider,
        maxTokens: config.primaryMaxTokens,
        contextWindow: config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow,
      },
      {
        model: config.extractionModel,
        provider: config.extractionProvider,
        maxTokens: config.extractionMaxTokens,
      },
    ];
  }

  return [
    config.modelRoster.reasoning,
    config.modelRoster.chat,
    {
      model: config.primaryModel,
      provider: config.primaryProvider,
      maxTokens: config.primaryMaxTokens,
      contextWindow: config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow,
    },
    config.modelRoster.background,
    {
      model: config.extractionModel,
      provider: config.extractionProvider,
      maxTokens: config.extractionMaxTokens,
    },
  ];
}

export function resolveRoutingCandidates(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];
  const seen = new Set<string>();
  const fallback = fallbackTokenBudget(config, purpose);

  const catalog = config.modelCatalog ?? {};
  const hasCatalog = Object.keys(catalog).length > 0;
  if (hasCatalog) {
    const slotChain = purposeSlotChain(config.modelRoleAssignments, purpose);
    for (const slotKey of slotChain) {
      const entry = catalog[slotKey];
      if (!entry) continue;
      uniquePush(
        candidates,
        candidateFromCatalogEntry(slotKey, entry, fallback),
        seen,
      );
    }

    for (const [slotKey, entry] of Object.entries(catalog)) {
      uniquePush(
        candidates,
        candidateFromCatalogEntry(slotKey, entry, fallback),
        seen,
      );
    }
  }

  for (const slot of rosterChain(config, purpose)) {
    uniquePush(candidates, candidateFromRosterSlot(slot), seen);
  }

  return candidates;
}
