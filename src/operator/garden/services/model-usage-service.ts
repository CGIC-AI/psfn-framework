import type {
  ModelUsageBreakdown,
  ModelUsageData,
  ModelUsageEvent,
  ModelUsageQuery,
  ModelUsageQueryPort,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
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
    private readonly store: ModelUsageQueryPort,
    private readonly modelDiscovery?: ModelDiscoveryBackend | null,
  ) {}

  async getModelUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    const data = await this.store.getUsageData(query);
    if (!this.modelDiscovery) return data;
    try {
      const pricingLookup = buildPricingLookup(await this.modelDiscovery.getAvailableModels());
      if (pricingLookup.size === 0) return data;
      return hydrateMissingModelUsageCosts(data, pricingLookup);
    } catch (error) {
      log.warn('Failed to hydrate model usage costs from discovery pricing', {
        error: error instanceof Error ? error.message : String(error),
      });
      return data;
    }
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
    || (Number.isFinite(event.estimatedCostUsd) && event.estimatedCostUsd > 0);
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
  if (Number.isFinite(event.estimatedCostUsd) && event.estimatedCostUsd > 0) {
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

function eventCostDelta(
  beforeEvents: readonly ModelUsageEvent[],
  afterEvents: readonly ModelUsageEvent[],
): number {
  let delta = 0;
  for (let index = 0; index < afterEvents.length; index += 1) {
    const before = beforeEvents[index];
    const after = afterEvents[index];
    if (before === after) continue;
    delta += eventCost(after) - eventCost(before);
  }
  return delta;
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

function hydrateBreakdownFromEvents(
  breakdown: readonly ModelUsageBreakdown[],
  beforeEvents: readonly ModelUsageEvent[],
  afterEvents: readonly ModelUsageEvent[],
  keyForEvent: (event: ModelUsageEvent) => string,
): ModelUsageBreakdown[] {
  const byKey = new Map(breakdown.map(entry => [entry.key, { ...entry }]));
  for (let index = 0; index < afterEvents.length; index += 1) {
    const before = beforeEvents[index];
    const after = afterEvents[index];
    if (before === after) continue;
    const key = keyForEvent(after);
    const existing = byKey.get(key);
    if (existing) {
      existing.totalCostUsd += eventCost(after) - eventCost(before);
    }
  }
  return [...byKey.values()].sort((left, right) => (
    right.totalCostUsd - left.totalCostUsd
    || right.totalTokens - left.totalTokens
    || right.calls - left.calls
    || left.key.localeCompare(right.key)
  ));
}

function hydrateMissingModelUsageCosts(
  data: ModelUsageData,
  lookup: ReadonlyMap<string, ModelPricingRates>,
): ModelUsageData {
  const recentEvents = data.recentEvents.map(event => hydrateEvent(event, lookup));
  const expensiveEvents = data.expensiveEvents
    .map(event => hydrateEvent(event, lookup))
    .sort((left, right) => eventCost(right) - eventCost(left) || right.recordedAtMs - left.recordedAtMs);
  const byModel = hydrateModelBreakdown(data.byModel, lookup);
  const modelAggregateDelta = breakdownCostTotal(byModel) - breakdownCostTotal(data.byModel);
  const recentEventDelta = eventCostDelta(data.recentEvents, recentEvents);
  const totalsCostDeltaUsd = Math.max(0, modelAggregateDelta, recentEventDelta);
  return {
    ...data,
    totals: hydrateTotals(data.totals, totalsCostDeltaUsd),
    byModel,
    byPurpose: hydrateBreakdownFromEvents(data.byPurpose, data.recentEvents, recentEvents, event => event.purpose),
    byTool: hydrateBreakdownFromEvents(data.byTool, data.recentEvents, recentEvents, event => event.toolName ?? '(none)'),
    byCallKind: hydrateBreakdownFromEvents(data.byCallKind, data.recentEvents, recentEvents, event => event.callKind),
    recentEvents,
    expensiveEvents,
  };
}
