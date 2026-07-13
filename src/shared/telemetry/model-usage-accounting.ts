import type {
  ModelUsageCostBreakdown,
  ModelUsageCostSource,
} from './model-usage.js';

export interface ModelUsageTokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ModelUsageTokenBucketsInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface ModelUsageCostRates {
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
  cacheReadPer1MUsd?: number;
  cacheWritePer1MUsd?: number;
  currency?: string;
}

export interface ReconciledModelUsageAccounting {
  usage: ModelUsageTokenBuckets;
  providerCost: ModelUsageCostBreakdown;
  estimatedCost: ModelUsageCostBreakdown;
  effectiveCost: ModelUsageCostBreakdown;
  costSource: ModelUsageCostSource;
}

export interface ReconcileModelUsageAccountingInput {
  usage: ModelUsageTokenBucketsInput;
  providerCost?: ModelUsageCostBreakdown;
  estimatedCost?: ModelUsageCostBreakdown;
  effectiveCost?: ModelUsageCostBreakdown;
  costSource?: ModelUsageCostSource;
  estimatedRates?: ModelUsageCostRates;
}

type CostBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

const COST_BUCKETS: ReadonlyArray<{
  cost: CostBucket;
  tokens: keyof Pick<ModelUsageTokenBuckets, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
  rate: keyof Pick<ModelUsageCostRates, 'inputPer1MUsd' | 'outputPer1MUsd' | 'cacheReadPer1MUsd' | 'cacheWritePer1MUsd'>;
}> = [
  { cost: 'input', tokens: 'inputTokens', rate: 'inputPer1MUsd' },
  { cost: 'output', tokens: 'outputTokens', rate: 'outputPer1MUsd' },
  { cost: 'cacheRead', tokens: 'cacheReadTokens', rate: 'cacheReadPer1MUsd' },
  { cost: 'cacheWrite', tokens: 'cacheWriteTokens', rate: 'cacheWritePer1MUsd' },
];

function normalizeCount(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeMoney(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function normalizeCurrency(value: string | undefined): string {
  const currency = value?.trim().toUpperCase();
  return currency || 'USD';
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

function normalizeUsage(input: ModelUsageTokenBucketsInput): ModelUsageTokenBuckets {
  const usage = {
    inputTokens: normalizeCount(input.inputTokens, 'inputTokens'),
    outputTokens: normalizeCount(input.outputTokens, 'outputTokens'),
    cacheReadTokens: normalizeCount(input.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: normalizeCount(input.cacheWriteTokens, 'cacheWriteTokens'),
  };
  const reconciledTotal = usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheWriteTokens;
  const totalTokens = input.totalTokens === undefined
    ? reconciledTotal
    : normalizeCount(input.totalTokens, 'totalTokens');
  if (totalTokens !== reconciledTotal) {
    throw new Error(
      `totalTokens must equal input + output + cacheRead + cacheWrite (${reconciledTotal})`,
    );
  }
  return { ...usage, totalTokens };
}

function normalizeCost(
  input: ModelUsageCostBreakdown | undefined,
): ModelUsageCostBreakdown {
  if (!input) return {};
  return {
    ...(normalizeMoney(input.input, 'cost.input') !== undefined
      ? { input: normalizeMoney(input.input, 'cost.input') }
      : {}),
    ...(normalizeMoney(input.output, 'cost.output') !== undefined
      ? { output: normalizeMoney(input.output, 'cost.output') }
      : {}),
    ...(normalizeMoney(input.cacheRead, 'cost.cacheRead') !== undefined
      ? { cacheRead: normalizeMoney(input.cacheRead, 'cost.cacheRead') }
      : {}),
    ...(normalizeMoney(input.cacheWrite, 'cost.cacheWrite') !== undefined
      ? { cacheWrite: normalizeMoney(input.cacheWrite, 'cost.cacheWrite') }
      : {}),
    ...(normalizeMoney(input.total, 'cost.total') !== undefined
      ? { total: normalizeMoney(input.total, 'cost.total') }
      : {}),
    currency: normalizeCurrency(input.currency),
  };
}

function estimateCost(
  usage: ModelUsageTokenBuckets,
  rates: ModelUsageCostRates | undefined,
): ModelUsageCostBreakdown {
  if (!rates) return {};
  const estimated: ModelUsageCostBreakdown = {
    currency: normalizeCurrency(rates.currency),
  };
  let allBillableBucketsKnown = true;
  let total = 0;

  for (const bucket of COST_BUCKETS) {
    const tokens = usage[bucket.tokens];
    const rate = normalizeMoney(rates[bucket.rate], `estimatedRates.${bucket.rate}`);
    if (tokens === 0) {
      estimated[bucket.cost] = 0;
      continue;
    }
    if (rate === undefined) {
      allBillableBucketsKnown = false;
      continue;
    }
    const component = roundUsd((tokens / 1_000_000) * rate);
    estimated[bucket.cost] = component;
    total += component;
  }

  if (allBillableBucketsKnown) {
    estimated.total = roundUsd(total);
  }
  return estimated;
}

function deriveCompleteProviderTotal(
  cost: ModelUsageCostBreakdown,
  usage: ModelUsageTokenBuckets,
): ModelUsageCostBreakdown {
  if (cost.total !== undefined) return cost;
  if (!COST_BUCKETS.some(bucket => cost[bucket.cost] !== undefined)) return cost;
  const completed = { ...cost };
  let total = 0;
  for (const bucket of COST_BUCKETS) {
    const component = cost[bucket.cost];
    if (component !== undefined) {
      total += component;
      continue;
    }
    if (usage[bucket.tokens] > 0) return cost;
    completed[bucket.cost] = 0;
  }
  completed.total = roundUsd(total);
  return completed;
}

export function reconcileModelUsageAccounting(
  input: ReconcileModelUsageAccountingInput,
): ReconciledModelUsageAccounting {
  const usage = normalizeUsage(input.usage);
  const normalizedProviderCost = normalizeCost(input.providerCost);
  const providerCost = input.providerCost
    ? deriveCompleteProviderTotal(normalizedProviderCost, usage)
    : normalizedProviderCost;
  if (input.estimatedCost && input.estimatedRates) {
    throw new Error('Provide estimatedCost or estimatedRates, not both');
  }
  const estimatedCost = input.estimatedCost
    ? normalizeCost(input.estimatedCost)
    : estimateCost(usage, input.estimatedRates);
  const providerTotal = providerCost.total;
  const estimatedTotal = estimatedCost.total;
  const resolvedEffectiveCost = providerTotal !== undefined
    ? { ...providerCost }
    : { ...estimatedCost };
  const resolvedCostSource: ModelUsageCostSource = providerTotal !== undefined
    ? 'provider'
    : (estimatedTotal !== undefined && estimatedTotal > 0 ? 'estimate' : 'none');
  const effectiveCost = input.effectiveCost
    ? normalizeCost(input.effectiveCost)
    : resolvedEffectiveCost;
  if (effectiveCost.total !== resolvedEffectiveCost.total) {
    throw new Error('effectiveCost.total must follow provider-total then estimated-total precedence');
  }
  if (input.costSource !== undefined && input.costSource !== resolvedCostSource) {
    throw new Error(`costSource must be ${resolvedCostSource} for the reconciled totals`);
  }

  return {
    usage,
    providerCost,
    estimatedCost,
    effectiveCost,
    costSource: resolvedCostSource,
  };
}
