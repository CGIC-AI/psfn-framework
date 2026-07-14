import type {
  ModelUsageBreakdown,
  ModelUsageCostHydrationBreakdown,
  ModelUsageCostHydrationData,
  ModelUsageCostHydrationQueryPort,
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageGroupDimension,
  ModelUsageQuery,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import { MODEL_USAGE_GROUP_DIMENSIONS } from '../../../shared/telemetry/model-usage-attribution.js';
import type { DiscoveredModel, ModelDiscoveryBackend } from '../../../primitives/llm/discovery.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { AdminModelUsageService } from './types.js';

interface ModelPricingRates {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  modelId: string;
}

const PER_TOKEN_TO_PER_MILLION = 1_000_000;
const LOOKUP_WRAPPER_PREFIXES = new Set(['openrouter', 'litellm', 'proxy']);
const log = createComponentLogger('AdminModelUsageDataService');

export class AdminModelUsageDataService implements AdminModelUsageService {
  constructor(
    private readonly store: ModelUsageCostHydrationQueryPort,
    private readonly modelDiscovery?: ModelDiscoveryBackend | null,
  ) {}

  async getModelUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    const data = await this.store.getUsageData(query);
    if (!this.modelDiscovery) return data;
    let availableModels: DiscoveredModel[];
    try {
      availableModels = await this.modelDiscovery.getAvailableModels();
    } catch (error) {
      log.warn('Failed to discover model pricing for usage cost hydration', {
        error: error instanceof Error ? error.message : String(error),
      });
      return data;
    }
    const pricingLookup = buildPricingLookup(availableModels);
    if (pricingLookup.size === 0) return data;
    const hydrationDimensions = [...new Set<ModelUsageGroupDimension>([
      'model',
      'purpose',
      'toolName',
      'callKind',
      ...(data.query.groupBy ?? []),
    ])];
    const costHydration = await this.store.getUsageCostHydrationData(
      data.query,
      hydrationDimensions,
    );
    return hydrateMissingModelUsageCosts(data, pricingLookup, costHydration);
  }
}

function normalizeLookupKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandModelLookupKeys(modelId: string | undefined): string[] {
  const base = normalizeLookupKey(modelId);
  if (!base) return [];
  const queue = [base];
  const keys: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);

    const slashIndex = candidate.indexOf('/');
    if (slashIndex > 0) {
      const prefix = candidate.slice(0, slashIndex);
      const rest = candidate.slice(slashIndex + 1).trim();
      if (rest && LOOKUP_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }

    const colonIndex = candidate.indexOf(':');
    if (colonIndex > 0) {
      const prefix = candidate.slice(0, colonIndex);
      const rest = candidate.slice(colonIndex + 1).trim();
      if (rest && LOOKUP_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }
  }
  return keys;
}

function normalizePricePer1M(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim()) : NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric * PER_TOKEN_TO_PER_MILLION;
}

function buildPricingLookup(models: readonly DiscoveredModel[]): Map<string, ModelPricingRates> {
  const lookup = new Map<string, ModelPricingRates>();
  for (const model of models) {
    const inputRate = normalizePricePer1M(model.pricing?.prompt);
    const outputRate = normalizePricePer1M(model.pricing?.completion);
    if (inputRate === undefined && outputRate === undefined) continue;
    const rates = {
      inputPer1MUsd: inputRate ?? outputRate ?? 0,
      outputPer1MUsd: outputRate ?? inputRate ?? 0,
      modelId: model.id,
    };
    for (const key of expandModelLookupKeys(model.id)) {
      if (!lookup.has(key)) lookup.set(key, rates);
    }
  }
  return lookup;
}

function findPricingRatesForModelId(
  modelId: string | undefined,
  lookup: ReadonlyMap<string, ModelPricingRates>,
): ModelPricingRates | undefined {
  for (const key of expandModelLookupKeys(modelId)) {
    const rates = lookup.get(key);
    if (rates) return rates;
  }
  return undefined;
}

function findPricingRates(
  event: ModelUsageEvent,
  lookup: ReadonlyMap<string, ModelPricingRates>,
): ModelPricingRates | undefined {
  const candidates = [
    event.model,
    event.requestedModel,
    event.metadata.rawUsage && typeof event.metadata.rawUsage === 'object'
      ? (event.metadata.rawUsage as Record<string, unknown>).model
      : undefined,
  ];
  for (const candidate of candidates) {
    const rates = findPricingRatesForModelId(typeof candidate === 'string' ? candidate : undefined, lookup);
    if (rates) return rates;
  }
  return undefined;
}

function estimateTokenCostUsd(
  inputTokenCount: number,
  outputTokenCount: number,
  rates: ModelPricingRates,
): number {
  const inputTokens = Math.max(0, Math.floor(inputTokenCount));
  const outputTokens = Math.max(0, Math.floor(outputTokenCount));
  return ((inputTokens / 1_000_000) * rates.inputPer1MUsd)
    + ((outputTokens / 1_000_000) * rates.outputPer1MUsd);
}

function estimateEventCostUsd(event: ModelUsageEvent, rates: ModelPricingRates): number {
  return estimateTokenCostUsd(event.inputTokens, event.outputTokens, rates);
}

function hasPositiveCost(event: ModelUsageEvent): boolean {
  return (typeof event.providerCostUsd === 'number' && Number.isFinite(event.providerCostUsd) && event.providerCostUsd > 0)
    || (typeof event.estimatedCostUsd === 'number'
      && Number.isFinite(event.estimatedCostUsd)
      && event.estimatedCostUsd > 0);
}

function hydrateEvent(
  event: ModelUsageEvent,
  lookup: ReadonlyMap<string, ModelPricingRates>,
): ModelUsageEvent {
  if (hasPositiveCost(event)) return event;
  if (event.inputTokens + event.outputTokens <= 0) return event;
  const rates = findPricingRates(event, lookup);
  if (!rates) return event;
  const estimatedCostUsd = estimateEventCostUsd(event, rates);
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0) return event;
  const { providerCostUsd, ...eventWithoutProviderCost } = event;
  return {
    ...eventWithoutProviderCost,
    ...(typeof providerCostUsd === 'number' && Number.isFinite(providerCostUsd) && providerCostUsd > 0
      ? { providerCostUsd }
      : {}),
    estimatedCostUsd,
    costSource: 'estimate',
    metadata: {
      ...event.metadata,
      costHydration: {
        source: 'model_discovery',
        modelId: rates.modelId,
      },
    },
  };
}

function cloneTotals(source: ModelUsageTotals): ModelUsageTotals {
  return { ...source };
}

function eventCost(event: ModelUsageEvent): number {
  if (typeof event.providerCostUsd === 'number' && Number.isFinite(event.providerCostUsd) && event.providerCostUsd > 0) {
    return event.providerCostUsd;
  }
  if (
    typeof event.estimatedCostUsd === 'number'
    && Number.isFinite(event.estimatedCostUsd)
    && event.estimatedCostUsd > 0
  ) {
    return event.estimatedCostUsd;
  }
  return 0;
}

function hydrateTotals(source: ModelUsageTotals, costDeltaUsd: number): ModelUsageTotals {
  const totals = cloneTotals(source);
  if (!Number.isFinite(costDeltaUsd) || costDeltaUsd <= 0) return totals;
  totals.estimatedCostUsd += costDeltaUsd;
  totals.totalCostUsd += costDeltaUsd;
  return totals;
}

function modelIdFromBreakdownKey(key: string): string {
  const separatorIndex = key.indexOf(':');
  return separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
}

function breakdownCostTotal(breakdown: readonly ModelUsageBreakdown[]): number {
  return breakdown.reduce((sum, entry) => sum + Math.max(0, entry.totalCostUsd), 0);
}

function hydrateModelBreakdown(
  breakdown: readonly ModelUsageBreakdown[],
  lookup: ReadonlyMap<string, ModelPricingRates>,
): ModelUsageBreakdown[] {
  return breakdown
    .map((entry) => {
      if (entry.totalCostUsd > 0 || entry.inputTokens + entry.outputTokens <= 0) return entry;
      const rates = findPricingRatesForModelId(modelIdFromBreakdownKey(entry.key), lookup);
      if (!rates) return entry;
      const estimatedCostUsd = estimateTokenCostUsd(entry.inputTokens, entry.outputTokens, rates);
      if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0) return entry;
      return {
        ...entry,
        totalCostUsd: estimatedCostUsd,
      };
    })
    .sort((left, right) => (
      right.totalCostUsd - left.totalCostUsd
      || right.totalTokens - left.totalTokens
      || right.calls - left.calls
      || left.key.localeCompare(right.key)
    ));
}

function hydratedAggregateCost(
  aggregate: ModelUsageCostHydrationBreakdown,
  lookup: ReadonlyMap<string, ModelPricingRates>,
): number {
  if (aggregate.totalCostUsd > 0 || aggregate.inputTokens + aggregate.outputTokens <= 0) {
    return aggregate.totalCostUsd;
  }
  const rates = findPricingRatesForModelId(modelIdFromBreakdownKey(aggregate.modelKey), lookup);
  if (!rates) return aggregate.totalCostUsd;
  const estimatedCostUsd = estimateTokenCostUsd(
    aggregate.inputTokens,
    aggregate.outputTokens,
    rates,
  );
  return Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0
    ? estimatedCostUsd
    : aggregate.totalCostUsd;
}

function hydrateBreakdownFromCostAggregates(
  breakdown: readonly ModelUsageBreakdown[],
  aggregates: readonly ModelUsageCostHydrationBreakdown[],
  lookup: ReadonlyMap<string, ModelPricingRates>,
  options: {
    keyForAggregate?: (aggregate: ModelUsageCostHydrationBreakdown) => string;
    includeAllAggregateKeys?: boolean;
    reclassifyEstimatedNone?: boolean;
  } = {},
): ModelUsageBreakdown[] {
  const allowedKeys = new Set(breakdown.map(entry => entry.key));
  const seenKeys = new Set<string>();
  const byKey = new Map<string, ModelUsageBreakdown>();
  for (const aggregate of aggregates) {
    const sourceKey = options.keyForAggregate?.(aggregate) ?? aggregate.key;
    if (!options.includeAllAggregateKeys && !allowedKeys.has(sourceKey)) continue;
    seenKeys.add(sourceKey);
    const cost = hydratedAggregateCost(aggregate, lookup);
    const outputKey = options.reclassifyEstimatedNone
      && aggregate.costSource === 'none'
      && cost > 0
      ? 'estimate'
      : sourceKey;
    const existing = byKey.get(outputKey) ?? {
      key: outputKey,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    };
    existing.calls += aggregate.calls;
    existing.inputTokens += aggregate.inputTokens;
    existing.outputTokens += aggregate.outputTokens;
    existing.cacheReadTokens += aggregate.cacheReadTokens;
    existing.cacheWriteTokens += aggregate.cacheWriteTokens;
    existing.totalTokens += aggregate.totalTokens;
    existing.totalCostUsd += cost;
    byKey.set(outputKey, existing);
  }
  for (const entry of breakdown) {
    if (!seenKeys.has(entry.key)) byKey.set(entry.key, { ...entry });
  }
  return [...byKey.values()]
    .filter(entry => entry.calls > 0)
    .sort((left, right) => (
    right.totalCostUsd - left.totalCostUsd
    || right.totalTokens - left.totalTokens
    || right.calls - left.calls
    || left.key.localeCompare(right.key)
  ));
}

function completeAggregateCostDelta(
  aggregates: readonly ModelUsageCostHydrationBreakdown[],
  lookup: ReadonlyMap<string, ModelPricingRates>,
): number {
  return aggregates.reduce((delta, aggregate) => (
    delta + hydratedAggregateCost(aggregate, lookup) - aggregate.totalCostUsd
  ), 0);
}

function hydrateMissingModelUsageCosts(
  data: ModelUsageData,
  lookup: ReadonlyMap<string, ModelPricingRates>,
  costHydration: ModelUsageCostHydrationData,
): ModelUsageData {
  const recentEvents = data.recentEvents.map(event => hydrateEvent(event, lookup));
  const expensiveEvents = data.expensiveEvents
    .map(event => hydrateEvent(event, lookup))
    .sort((left, right) => eventCost(right) - eventCost(left) || right.recordedAtMs - left.recordedAtMs);
  const modelAggregates = costHydration.byDimension.model ?? [];
  const byModel = modelAggregates.length > 0
    ? hydrateBreakdownFromCostAggregates(data.byModel, modelAggregates, lookup, {
        keyForAggregate: aggregate => aggregate.modelKey,
      })
    : hydrateModelBreakdown(data.byModel, lookup);
  const totalsCostDeltaUsd = modelAggregates.length > 0
    ? Math.max(0, completeAggregateCostDelta(modelAggregates, lookup))
    : Math.max(0, breakdownCostTotal(byModel) - breakdownCostTotal(data.byModel));
  const groupedBy: ModelUsageData['groupedBy'] = {};
  for (const dimension of MODEL_USAGE_GROUP_DIMENSIONS) {
    const breakdown = data.groupedBy[dimension];
    if (!breakdown) continue;
    groupedBy[dimension] = hydrateBreakdownFromCostAggregates(
      breakdown,
      costHydration.byDimension[dimension] ?? [],
      lookup,
      {
        includeAllAggregateKeys: true,
        reclassifyEstimatedNone: dimension === 'costSource',
      },
    );
  }
  return {
    ...data,
    totals: hydrateTotals(data.totals, totalsCostDeltaUsd),
    byModel,
    byPurpose: hydrateBreakdownFromCostAggregates(
      data.byPurpose,
      costHydration.byDimension.purpose ?? [],
      lookup,
    ),
    byTool: hydrateBreakdownFromCostAggregates(
      data.byTool,
      costHydration.byDimension.toolName ?? [],
      lookup,
    ),
    byCallKind: hydrateBreakdownFromCostAggregates(
      data.byCallKind,
      costHydration.byDimension.callKind ?? [],
      lookup,
    ),
    groupedBy,
    recentEvents,
    expensiveEvents,
  };
}
