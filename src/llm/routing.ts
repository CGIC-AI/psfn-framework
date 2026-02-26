import type {
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelRoleAssignments,
  ModelSlot,
  SubstrateConfig,
} from '../types.js';

export type RoutingPurpose = 'chat' | 'background' | 'reasoning' | 'import_processing';
export type ImportPolicyRejectionReason = 'strict_requires_openrouter_zdr';

export interface RoutingCandidate {
  model: string;
  provider: string;
  maxTokens: number;
  contextWindow?: number;
  slotKey?: string;
  requestBaseUrl?: string;
  requestApiKeyEnv?: string;
  openRouterProviderOrder?: string[];
  openRouterZdrOnly?: boolean;
  importRouteMode?: ImportProcessingRouteMode;
}

export interface ImportPolicyAuditRecord {
  purpose: RoutingPurpose;
  strictPolicyEnabled: boolean;
  configuredRouteMode: ImportProcessingRouteMode;
  selectedRouteMode: ImportProcessingRouteMode;
  provider: string;
  model: string;
  openRouterZdrOnly: boolean;
  requestBaseUrl?: string;
}

export interface ImportPolicyEvaluation {
  allowed: boolean;
  reason?: ImportPolicyRejectionReason;
  audit: ImportPolicyAuditRecord;
}

function uniquePush(
  target: RoutingCandidate[],
  candidate: RoutingCandidate | undefined,
  seen: Set<string>,
): void {
  if (!candidate) return;
  const key = [
    candidate.provider,
    candidate.model,
    String(candidate.maxTokens),
    candidate.requestBaseUrl ?? '',
    candidate.requestApiKeyEnv ?? '',
    candidate.openRouterZdrOnly ? 'zdr' : '',
    candidate.openRouterProviderOrder?.join(',') ?? '',
    candidate.importRouteMode ?? '',
  ].join('::');

  if (seen.has(key)) return;
  seen.add(key);
  target.push(candidate);
}

function fallbackTokenBudget(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
): { maxTokens: number; contextWindow?: number } {
  if (purpose === 'background' || purpose === 'import_processing') {
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
      : purpose === 'reasoning'
        ? [
          role.reasoning,
          role.chat,
          'primary',
          role.background,
          role.extraction,
          'extraction',
        ]
        : [
          role.import_processing,
          role.import,
          role.background,
          role.extraction,
          'extraction',
          role.chat,
          'primary',
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

  if (purpose === 'reasoning') {
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

function withOpenRouterPreferences(
  candidate: RoutingCandidate | undefined,
  config: SubstrateConfig,
): RoutingCandidate | undefined {
  if (!candidate || candidate.provider !== 'openrouter') return candidate;
  const providerOrder = config.openRouterProviderOrder?.filter(Boolean) ?? [];
  if (providerOrder.length === 0) return candidate;

  return {
    ...candidate,
    openRouterProviderOrder: [...providerOrder],
  };
}

function buildStandardCandidates(
  config: SubstrateConfig,
  purpose: Exclude<RoutingPurpose, 'import_processing'>,
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
        withOpenRouterPreferences(candidateFromCatalogEntry(slotKey, entry, fallback), config),
        seen,
      );
    }

    for (const [slotKey, entry] of Object.entries(catalog)) {
      uniquePush(
        candidates,
        withOpenRouterPreferences(candidateFromCatalogEntry(slotKey, entry, fallback), config),
        seen,
      );
    }
  }

  for (const slot of rosterChain(config, purpose)) {
    uniquePush(candidates, withOpenRouterPreferences(candidateFromRosterSlot(slot), config), seen);
  }

  return candidates;
}

function resolveImportRouteMode(config: SubstrateConfig): ImportProcessingRouteMode {
  return config.importProcessingRouteMode ?? 'background';
}

function resolveLocalImportCandidate(config: SubstrateConfig): RoutingCandidate | undefined {
  const endpointUrl = config.importProcessingLocalEndpointUrl?.trim();
  const model = config.importProcessingLocalModel?.trim();
  if (!endpointUrl || !model) return undefined;
  if (!Number.isFinite(config.extractionMaxTokens) || config.extractionMaxTokens <= 0) return undefined;

  return {
    model,
    provider: 'local_endpoint',
    maxTokens: config.extractionMaxTokens,
    requestBaseUrl: endpointUrl,
    requestApiKeyEnv: 'IMPORT_PROCESSING_LOCAL_API_KEY',
    importRouteMode: 'local_endpoint',
  };
}

function resolveImportRoutingCandidates(config: SubstrateConfig): RoutingCandidate[] {
  const routeMode = resolveImportRouteMode(config);
  const backgroundCandidates = buildStandardCandidates(config, 'background');

  if (routeMode === 'openrouter_zdr') {
    return backgroundCandidates
      .filter(candidate => candidate.provider === 'openrouter')
      .map(candidate => ({
        ...candidate,
        openRouterZdrOnly: true,
        importRouteMode: 'openrouter_zdr' as const,
      }));
  }

  if (routeMode === 'local_endpoint') {
    const localCandidate = resolveLocalImportCandidate(config);
    return localCandidate ? [localCandidate] : [];
  }

  return backgroundCandidates.map(candidate => ({
    ...candidate,
    importRouteMode: 'background' as const,
  }));
}

export function evaluateImportPolicy(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
  candidate: RoutingCandidate,
): ImportPolicyEvaluation {
  const configuredRouteMode = resolveImportRouteMode(config);
  const selectedRouteMode = candidate.importRouteMode ?? configuredRouteMode;
  const strictPolicyEnabled = config.importProcessingStrictPolicy === true;
  const openRouterZdrOnly = candidate.provider === 'openrouter' && candidate.openRouterZdrOnly === true;

  const audit: ImportPolicyAuditRecord = {
    purpose,
    strictPolicyEnabled,
    configuredRouteMode,
    selectedRouteMode,
    provider: candidate.provider,
    model: candidate.model,
    openRouterZdrOnly,
    ...(candidate.requestBaseUrl ? { requestBaseUrl: candidate.requestBaseUrl } : {}),
  };

  if (purpose !== 'import_processing' || !strictPolicyEnabled) {
    return { allowed: true, audit };
  }

  if (!openRouterZdrOnly) {
    return {
      allowed: false,
      reason: 'strict_requires_openrouter_zdr',
      audit,
    };
  }

  return { allowed: true, audit };
}

export function resolveRoutingCandidates(
  config: SubstrateConfig,
  purpose: RoutingPurpose,
): RoutingCandidate[] {
  if (purpose === 'import_processing') {
    return resolveImportRoutingCandidates(config);
  }

  return buildStandardCandidates(config, purpose);
}
