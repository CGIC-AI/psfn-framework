import type {
  CorrelationMetadata,
  ModelBudgetBlockedEvent,
  ModelBudgetBlockReason,
  ModelBudgetThresholdExceededEvent,
  ModelBudgetWindowSnapshot,
  ModelRegistryEntry,
} from '../../shared/contracts/runtime.js';
import type {
  ModelUsageBudgetQueryPort,
  ModelUsageBudgetPricingRate,
  ModelUsageBudgetSpendSnapshot,
} from '../../shared/telemetry/model-usage.js';
import type { ModelUsageCostRates } from '../../shared/telemetry/model-usage-accounting.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { RoutingCandidate, RoutingPurpose } from './routing.js';
import { resolveOwnerCostRates, type ResolvedSlotPrice } from './model-pricing/slot-price.js';

export interface BudgetPreflightParams {
  candidate: RoutingCandidate;
  purpose: RoutingPurpose;
  service: string;
  process: string;
  estimatedInputTokens: number;
  estimatedOutputTokens?: number;
  correlation?: Partial<CorrelationMetadata>;
  nowMs?: number;
  /**
   * A non-token dispatch (e.g. image generation) priced by its caller at its
   * worst case from owner-file pricing; replaces the registry token estimate.
   */
  fixedEstimatedCostUsd?: number;
}

export interface BudgetPreflightResult {
  allowed: boolean;
  estimatedRequestCostUsd: number;
  snapshot: ModelBudgetWindowSnapshot | null;
  blockedEvent?: ModelBudgetBlockedEvent;
  thresholdEvent?: ModelBudgetThresholdExceededEvent;
  accountingError?: Error;
}

export class ModelBudgetExceededError extends Error {
  readonly code = 'model_budget_blocked';
  readonly event: ModelBudgetBlockedEvent;

  constructor(event: ModelBudgetBlockedEvent, cause?: Error) {
    super(
      `Model budget blocked candidate ${event.provider}:${event.model} (${event.reason})`,
      cause ? { cause } : undefined,
    );
    this.name = 'ModelBudgetExceededError';
    this.event = event;
  }
}

function toModelKey(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = normalizeModelIdForProvider(normalizedProvider, model);
  return `${normalizedProvider}::${normalizedModel}`;
}

function normalizeModelIdLoose(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith('openrouter/')
    ? trimmed.slice('openrouter/'.length)
    : trimmed;
}

function sanitizeService(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function sanitizePurpose(value: RoutingPurpose): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : 'unknown';
}

function sanitizeProcess(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

export interface ModelUsagePricingIdentity {
  provider: string;
  model: string;
  slotKey?: string;
}

function resolveRegistryEntryForIdentity(
  config: SubstrateConfig,
  identity: ModelUsagePricingIdentity,
  purpose?: RoutingPurpose,
): ModelRegistryEntry | undefined {
  const registry = config.modelRegistry;
  if (!registry) return undefined;

  if (identity.slotKey) {
    const byId = registry.models.find(entry => entry.id === identity.slotKey);
    if (!byId || byId.enabled === false) return undefined;
    return toModelKey(byId.identity.provider, byId.identity.model)
      === toModelKey(identity.provider, identity.model)
      ? byId
      : undefined;
  }

  const candidateKey = toModelKey(identity.provider, identity.model);
  const matches = registry.models.filter(
    entry => entry.enabled !== false
      && (!purpose || entry.purposes.some(tag => tag.purpose === purpose))
      && toModelKey(entry.identity.provider, entry.identity.model) === candidateKey,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The slot's current price (lomm1): the gateway price book when wired (fresh
 * catalogue price, then owner `cost`), else the owner `cost` alone. `atMs` is
 * when the priced attempt started, so admission and booking of one attempt
 * read the same quote.
 */
export function resolveEntryPrice(
  config: SubstrateConfig,
  entry: ModelRegistryEntry | undefined,
  atMs: number,
): ResolvedSlotPrice {
  if (!entry) return { source: 'unknown' };
  if (config.modelPriceBook) return config.modelPriceBook.resolve(entry, atMs);
  const owner = resolveOwnerCostRates(entry);
  return owner ? { source: 'owner', rates: owner } : { source: 'unknown' };
}

/** Admission needs both token rates; nothing is borrowed from another bucket. */
function resolveAdmissionRates(
  price: ResolvedSlotPrice,
): { inputPer1MUsd: number; outputPer1MUsd: number } | null {
  const input = price.rates?.inputPer1MUsd;
  const output = price.rates?.outputPer1MUsd;
  if (input === undefined || output === undefined) return null;
  return { inputPer1MUsd: input, outputPer1MUsd: output };
}

export function resolveModelUsagePrice(
  config: SubstrateConfig,
  candidate: RoutingCandidate,
  purpose: RoutingPurpose | undefined,
  atMs: number,
): ResolvedSlotPrice {
  return resolveEntryPrice(config, resolveRegistryEntryForIdentity(config, candidate, purpose), atMs);
}

export function resolveModelUsageCostRates(
  config: SubstrateConfig,
  candidate: RoutingCandidate,
  purpose?: RoutingPurpose,
  atMs = Date.now(),
): ModelUsageCostRates | undefined {
  return resolveModelUsagePrice(config, candidate, purpose, atMs).rates;
}

export function resolveModelUsageCostRatesForIdentity(
  config: SubstrateConfig,
  identity: ModelUsagePricingIdentity,
  atMs = Date.now(),
): ModelUsageCostRates | undefined {
  return resolveEntryPrice(config, resolveRegistryEntryForIdentity(config, identity), atMs).rates;
}

function resolveHistoricalBudgetPricing(
  config: SubstrateConfig,
  nowMs: number,
): ModelUsageBudgetPricingRate[] {
  return (config.modelRegistry?.models ?? []).flatMap((entry) => {
    if (entry.enabled === false) return [];
    const rates = resolveEntryPrice(config, entry, nowMs).rates;
    if (
      rates?.inputPer1MUsd === undefined
      || rates.outputPer1MUsd === undefined
      || rates.cacheReadPer1MUsd === undefined
      || rates.cacheWritePer1MUsd === undefined
    ) {
      return [];
    }
    const provider = entry.identity.provider.trim().toLowerCase();
    return [{
      slotKey: entry.id,
      provider,
      model: normalizeModelIdForProvider(provider, entry.identity.model),
      inputPer1MUsd: rates.inputPer1MUsd,
      outputPer1MUsd: rates.outputPer1MUsd,
      cacheReadPer1MUsd: rates.cacheReadPer1MUsd,
      cacheWritePer1MUsd: rates.cacheWritePer1MUsd,
    }];
  });
}

function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  rates: { inputPer1MUsd: number; outputPer1MUsd: number } | null,
): number {
  if (!rates) return 0;
  const input = Math.max(0, Math.floor(inputTokens));
  const output = Math.max(0, Math.floor(outputTokens));
  return ((input / 1_000_000) * rates.inputPer1MUsd)
    + ((output / 1_000_000) * rates.outputPer1MUsd);
}

function emptySpendSnapshot(nowMs: number): ModelUsageBudgetSpendSnapshot {
  const timestamp = new Date(nowMs);
  return {
    dayKey: timestamp.toISOString().slice(0, 10),
    monthKey: timestamp.toISOString().slice(0, 7),
    dailyEstimatedCostUsd: 0,
    monthlyEstimatedCostUsd: 0,
    dailyUnknownCostAttempts: 0,
    monthlyUnknownCostAttempts: 0,
  };
}

function toWindowSnapshot(
  spend: ModelUsageBudgetSpendSnapshot,
  dailyLimitUsd: number,
  monthlyLimitUsd: number,
): ModelBudgetWindowSnapshot {
  return {
    dayKey: spend.dayKey,
    monthKey: spend.monthKey,
    dailySpentUsd: spend.dailyEstimatedCostUsd,
    dailyLimitUsd,
    monthlySpentUsd: spend.monthlyEstimatedCostUsd,
    monthlyLimitUsd,
    dailyUnknownCostAttempts: spend.dailyUnknownCostAttempts,
    monthlyUnknownCostAttempts: spend.monthlyUnknownCostAttempts,
  };
}

function buildBlockedEvent(
  reason: ModelBudgetBlockReason,
  nowMs: number,
  params: BudgetPreflightParams,
  estimatedRequestCostUsd: number,
  snapshot: ModelBudgetWindowSnapshot,
): ModelBudgetBlockedEvent {
  const { candidate, correlation } = params;
  return {
    timestampMs: nowMs,
    reason,
    purpose: sanitizePurpose(params.purpose),
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
    service: sanitizeService(params.service),
    process: sanitizeProcess(params.process),
    estimatedRequestCostUsd,
    budget: snapshot,
    ...(correlation?.turnId ? { turnId: correlation.turnId } : {}),
    ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
    ...(correlation?.channelId ? { channelId: correlation.channelId } : {}),
    ...(correlation?.companionId ? { companionId: correlation.companionId } : {}),
    ...(correlation?.callType ? { callType: correlation.callType } : {}),
    ...(correlation?.originType ? { originType: correlation.originType } : {}),
    ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
  };
}

function buildThresholdEvent(
  budgetEvent: ModelBudgetBlockedEvent,
  enforcementEnabled: boolean,
): ModelBudgetThresholdExceededEvent {
  if (
    budgetEvent.reason !== 'daily_budget_exceeded'
    && budgetEvent.reason !== 'monthly_budget_exceeded'
  ) {
    throw new Error('Model budget threshold event requires a threshold reason');
  }
  return {
    ...budgetEvent,
    reason: budgetEvent.reason,
    enforcementEnabled,
  };
}

export function normalizeModelIdForProvider(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const trimmedModel = model.trim();
  if (normalizedProvider === 'openrouter' && trimmedModel.startsWith('openrouter/')) {
    return trimmedModel.slice('openrouter/'.length);
  }
  return trimmedModel;
}

export function findRegistryEntryByProviderModel(
  config: SubstrateConfig,
  provider: string,
  model: string,
): ModelRegistryEntry | undefined {
  const registry = config.modelRegistry;
  if (!registry) return undefined;
  const targetKey = toModelKey(provider, model);
  const matches = registry.models.filter(
    entry => toModelKey(entry.identity.provider, entry.identity.model) === targetKey,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function findRegistryEntryByModelId(
  config: SubstrateConfig,
  model: string,
): ModelRegistryEntry | undefined {
  const registry = config.modelRegistry;
  if (!registry) return undefined;
  const targetModel = normalizeModelIdLoose(model);
  const matches = registry.models.filter(
    entry => normalizeModelIdLoose(entry.identity.model) === targetModel,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export class ModelBudgetController {
  constructor(
    private readonly config: SubstrateConfig,
    private readonly usageQuery?: ModelUsageBudgetQueryPort,
  ) {}

  /** True when the owner-file budget policy refuses over-budget dispatch. */
  isEnforced(): boolean {
    return this.config.modelRegistry?.budgetPolicy?.enabled === true;
  }

  requiresPreflightEstimate(): boolean {
    return this.config.modelRegistry?.budgetPolicy !== undefined;
  }

  async evaluatePreflight(params: BudgetPreflightParams): Promise<BudgetPreflightResult> {
    const nowMs = params.nowMs ?? Date.now();
    const policy = this.config.modelRegistry?.budgetPolicy;
    if (!policy) {
      return { allowed: true, estimatedRequestCostUsd: 0, snapshot: null };
    }

    if (policy.accountingStartMs !== undefined && policy.accountingStartMs > nowMs) {
      const snapshot = toWindowSnapshot(
        emptySpendSnapshot(nowMs),
        policy.dailyUsdLimit,
        policy.monthlyUsdLimit,
      );
      const accountingError = new Error(
        'Model budget accountingStartMs cannot be later than the preflight timestamp',
      );
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd: 0,
        snapshot,
        ...(policy.enabled
          ? { blockedEvent: buildBlockedEvent('accounting_unavailable', nowMs, params, 0, snapshot) }
          : {}),
        accountingError,
      };
    }

    if (!this.usageQuery) {
      const snapshot = toWindowSnapshot(
        emptySpendSnapshot(nowMs),
        policy.dailyUsdLimit,
        policy.monthlyUsdLimit,
      );
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd: 0,
        snapshot,
        ...(policy.enabled
          ? { blockedEvent: buildBlockedEvent('accounting_unavailable', nowMs, params, 0, snapshot) }
          : {}),
      };
    }

    let spend: ModelUsageBudgetSpendSnapshot;
    try {
      const companionId = params.correlation?.companionId?.trim();
      const historicalPricing = resolveHistoricalBudgetPricing(this.config, nowMs);
      const scope = companionId || policy.accountingStartMs !== undefined
        ? {
            ...(companionId ? { companionId } : {}),
            ...(policy.accountingStartMs !== undefined
              ? { accountingStartMs: policy.accountingStartMs }
              : {}),
          }
        : undefined;
      spend = await this.usageQuery.getModelBudgetSpend(nowMs, scope, historicalPricing);
    } catch (error) {
      const accountingError = error instanceof Error ? error : new Error(String(error));
      const snapshot = toWindowSnapshot(
        emptySpendSnapshot(nowMs),
        policy.dailyUsdLimit,
        policy.monthlyUsdLimit,
      );
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd: 0,
        snapshot,
        ...(policy.enabled
          ? { blockedEvent: buildBlockedEvent('accounting_unavailable', nowMs, params, 0, snapshot) }
          : {}),
        accountingError,
      };
    }

    const snapshot = toWindowSnapshot(spend, policy.dailyUsdLimit, policy.monthlyUsdLimit);
    if (spend.dailyUnknownCostAttempts > 0 || spend.monthlyUnknownCostAttempts > 0) {
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd: 0,
        snapshot,
        ...(policy.enabled
          ? { blockedEvent: buildBlockedEvent('unknown_historical_cost', nowMs, params, 0, snapshot) }
          : {}),
      };
    }

    let estimatedRequestCostUsd: number;
    if (params.fixedEstimatedCostUsd !== undefined) {
      if (!Number.isFinite(params.fixedEstimatedCostUsd) || params.fixedEstimatedCostUsd < 0) {
        throw new Error('fixedEstimatedCostUsd must be a finite number >= 0');
      }
      estimatedRequestCostUsd = params.fixedEstimatedCostUsd;
    } else {
      const rates = resolveAdmissionRates(
        resolveModelUsagePrice(this.config, params.candidate, params.purpose, nowMs),
      );
      if (!rates) {
        return {
          allowed: !policy.enabled,
          estimatedRequestCostUsd: 0,
          snapshot,
          ...(policy.enabled
            ? { blockedEvent: buildBlockedEvent('missing_cost_metadata', nowMs, params, 0, snapshot) }
            : {}),
        };
      }
      estimatedRequestCostUsd = estimateCostUsd(
        params.estimatedInputTokens,
        params.estimatedOutputTokens ?? params.candidate.maxTokens,
        rates,
      );
    }
    if (snapshot.dailySpentUsd + estimatedRequestCostUsd > snapshot.dailyLimitUsd) {
      const budgetEvent = buildBlockedEvent(
        'daily_budget_exceeded', nowMs, params, estimatedRequestCostUsd, snapshot,
      );
      const thresholdEvent = buildThresholdEvent(budgetEvent, policy.enabled);
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd,
        snapshot,
        thresholdEvent,
        ...(policy.enabled ? { blockedEvent: budgetEvent } : {}),
      };
    }
    if (snapshot.monthlySpentUsd + estimatedRequestCostUsd > snapshot.monthlyLimitUsd) {
      const budgetEvent = buildBlockedEvent(
        'monthly_budget_exceeded', nowMs, params, estimatedRequestCostUsd, snapshot,
      );
      const thresholdEvent = buildThresholdEvent(budgetEvent, policy.enabled);
      return {
        allowed: !policy.enabled,
        estimatedRequestCostUsd,
        snapshot,
        thresholdEvent,
        ...(policy.enabled ? { blockedEvent: budgetEvent } : {}),
      };
    }
    return { allowed: true, estimatedRequestCostUsd, snapshot };
  }
}
