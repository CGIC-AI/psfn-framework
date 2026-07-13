import type {
  CorrelationMetadata,
  ModelBudgetBlockedEvent,
  ModelBudgetBlockReason,
  ModelBudgetWindowSnapshot,
  ModelRegistryEntry,
} from '../../shared/contracts/runtime.js';
import type {
  ModelUsageBudgetQueryPort,
  ModelUsageBudgetSpendSnapshot,
} from '../../shared/telemetry/model-usage.js';
import type { ModelUsageCostRates } from '../../shared/telemetry/model-usage-accounting.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { RoutingCandidate, RoutingPurpose } from './routing.js';

export interface BudgetPreflightParams {
  candidate: RoutingCandidate;
  purpose: RoutingPurpose;
  service: string;
  process: string;
  estimatedInputTokens: number;
  estimatedOutputTokens?: number;
  correlation?: Partial<CorrelationMetadata>;
  nowMs?: number;
}

export interface BudgetPreflightResult {
  allowed: boolean;
  estimatedRequestCostUsd: number;
  snapshot: ModelBudgetWindowSnapshot | null;
  blockedEvent?: ModelBudgetBlockedEvent;
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

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
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
    if (purpose && !byId.purposes.some(tag => tag.purpose === purpose)) return undefined;
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

function resolveUsdCostRates(
  entry: ModelRegistryEntry | undefined,
): { inputPer1MUsd: number; outputPer1MUsd: number } | null {
  if (!entry) return null;
  const currency = typeof entry.cost?.currency === 'string'
    ? entry.cost.currency.trim().toUpperCase()
    : 'USD';
  if (currency !== 'USD') return null;

  const inputRate = toPositiveNumber(entry.cost?.inputPer1MUsd);
  const outputRate = toPositiveNumber(entry.cost?.outputPer1MUsd);
  if (inputRate === undefined && outputRate === undefined) return null;
  return {
    inputPer1MUsd: inputRate ?? outputRate ?? 0,
    outputPer1MUsd: outputRate ?? inputRate ?? 0,
  };
}

export function resolveModelUsageCostRates(
  config: SubstrateConfig,
  candidate: RoutingCandidate,
  purpose?: RoutingPurpose,
): ModelUsageCostRates | undefined {
  return resolveCostRatesForEntry(resolveRegistryEntryForIdentity(config, candidate, purpose));
}

export function resolveModelUsageCostRatesForIdentity(
  config: SubstrateConfig,
  identity: ModelUsagePricingIdentity,
): ModelUsageCostRates | undefined {
  return resolveCostRatesForEntry(resolveRegistryEntryForIdentity(config, identity));
}

function resolveCostRatesForEntry(
  entry: ModelRegistryEntry | undefined,
): ModelUsageCostRates | undefined {
  if (!entry?.cost) return undefined;
  const currency = typeof entry.cost.currency === 'string'
    ? entry.cost.currency.trim().toUpperCase()
    : 'USD';
  if (currency !== 'USD') return undefined;
  const rate = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined
  );
  const rates: ModelUsageCostRates = {
    ...(rate(entry.cost.inputPer1MUsd) !== undefined
      ? { inputPer1MUsd: rate(entry.cost.inputPer1MUsd) }
      : {}),
    ...(rate(entry.cost.outputPer1MUsd) !== undefined
      ? { outputPer1MUsd: rate(entry.cost.outputPer1MUsd) }
      : {}),
    ...(rate(entry.cost.cacheReadPer1MUsd) !== undefined
      ? { cacheReadPer1MUsd: rate(entry.cost.cacheReadPer1MUsd) }
      : {}),
    ...(rate(entry.cost.cacheWritePer1MUsd) !== undefined
      ? { cacheWritePer1MUsd: rate(entry.cost.cacheWritePer1MUsd) }
      : {}),
    currency,
  };
  return Object.keys(rates).length > 1 ? rates : undefined;
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
    ...(correlation?.callType ? { callType: correlation.callType } : {}),
    ...(correlation?.originType ? { originType: correlation.originType } : {}),
    ...(correlation?.originStage ? { originStage: correlation.originStage } : {}),
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

  requiresPreflightEstimate(): boolean {
    return this.config.modelRegistry?.budgetPolicy?.enabled === true;
  }

  async evaluatePreflight(params: BudgetPreflightParams): Promise<BudgetPreflightResult> {
    const nowMs = params.nowMs ?? Date.now();
    const policy = this.config.modelRegistry?.budgetPolicy;
    if (!this.requiresPreflightEstimate() || !policy) {
      return { allowed: true, estimatedRequestCostUsd: 0, snapshot: null };
    }

    if (!this.usageQuery) {
      const snapshot = toWindowSnapshot(
        emptySpendSnapshot(nowMs),
        policy.dailyUsdLimit,
        policy.monthlyUsdLimit,
      );
      return {
        allowed: false,
        estimatedRequestCostUsd: 0,
        snapshot,
        blockedEvent: buildBlockedEvent('accounting_unavailable', nowMs, params, 0, snapshot),
      };
    }

    let spend: ModelUsageBudgetSpendSnapshot;
    try {
      spend = await this.usageQuery.getModelBudgetSpend(nowMs);
    } catch (error) {
      const accountingError = error instanceof Error ? error : new Error(String(error));
      const snapshot = toWindowSnapshot(
        emptySpendSnapshot(nowMs),
        policy.dailyUsdLimit,
        policy.monthlyUsdLimit,
      );
      return {
        allowed: false,
        estimatedRequestCostUsd: 0,
        snapshot,
        blockedEvent: buildBlockedEvent('accounting_unavailable', nowMs, params, 0, snapshot),
        accountingError,
      };
    }

    const snapshot = toWindowSnapshot(spend, policy.dailyUsdLimit, policy.monthlyUsdLimit);
    if (spend.dailyUnknownCostAttempts > 0 || spend.monthlyUnknownCostAttempts > 0) {
      return {
        allowed: false,
        estimatedRequestCostUsd: 0,
        snapshot,
        blockedEvent: buildBlockedEvent('unknown_historical_cost', nowMs, params, 0, snapshot),
      };
    }

    const entry = resolveRegistryEntryForIdentity(this.config, params.candidate, params.purpose);
    const rates = resolveUsdCostRates(entry);
    if (!rates) {
      return {
        allowed: false,
        estimatedRequestCostUsd: 0,
        snapshot,
        blockedEvent: buildBlockedEvent('missing_cost_metadata', nowMs, params, 0, snapshot),
      };
    }

    const estimatedRequestCostUsd = estimateCostUsd(
      params.estimatedInputTokens,
      params.estimatedOutputTokens ?? params.candidate.maxTokens,
      rates,
    );
    if (snapshot.dailySpentUsd + estimatedRequestCostUsd > snapshot.dailyLimitUsd) {
      return {
        allowed: false,
        estimatedRequestCostUsd,
        snapshot,
        blockedEvent: buildBlockedEvent(
          'daily_budget_exceeded', nowMs, params, estimatedRequestCostUsd, snapshot,
        ),
      };
    }
    if (snapshot.monthlySpentUsd + estimatedRequestCostUsd > snapshot.monthlyLimitUsd) {
      return {
        allowed: false,
        estimatedRequestCostUsd,
        snapshot,
        blockedEvent: buildBlockedEvent(
          'monthly_budget_exceeded', nowMs, params, estimatedRequestCostUsd, snapshot,
        ),
      };
    }
    return { allowed: true, estimatedRequestCostUsd, snapshot };
  }
}
