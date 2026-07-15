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

function normalizeCurrency(value: string | undefined, field: string): string {
  const currency = value?.trim().toUpperCase();
  if (currency && currency !== 'USD') {
    throw new Error(`${field} must be USD until explicit currency conversion is implemented`);
  }
  return 'USD';
}

export function roundModelUsageUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

/** Conservative USD quantization for pre-provider admission decisions. */
export function ceilModelUsageUsd(value: number): number {
  return Math.ceil(value * 1_000_000_000_000) / 1_000_000_000_000;
}

/**
 * Projects the worst-case token envelope without rounding a positive provider
 * charge down. Missing pricing for any non-empty billable bucket stays unknown.
 */
export function estimateConservativeModelUsageCostUsd(
  input: ModelUsageTokenBucketsInput,
  rates: ModelUsageCostRates | undefined,
): number | undefined {
  if (!rates) return undefined;
  const usage = normalizeUsage(input);
  normalizeCurrency(rates.currency, 'estimatedRates.currency');
  let total = 0;
  for (const bucket of COST_BUCKETS) {
    const tokens = usage[bucket.tokens];
    if (tokens === 0) continue;
    const rate = normalizeMoney(rates[bucket.rate], `estimatedRates.${bucket.rate}`);
    if (rate === undefined) return undefined;
    total += (tokens / 1_000_000) * rate;
  }
  return ceilModelUsageUsd(total);
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
  field: string,
): ModelUsageCostBreakdown {
  if (!input) return {};
  return {
    ...(normalizeMoney(input.input, `${field}.input`) !== undefined
      ? { input: normalizeMoney(input.input, `${field}.input`) }
      : {}),
    ...(normalizeMoney(input.output, `${field}.output`) !== undefined
      ? { output: normalizeMoney(input.output, `${field}.output`) }
      : {}),
    ...(normalizeMoney(input.cacheRead, `${field}.cacheRead`) !== undefined
      ? { cacheRead: normalizeMoney(input.cacheRead, `${field}.cacheRead`) }
      : {}),
    ...(normalizeMoney(input.cacheWrite, `${field}.cacheWrite`) !== undefined
      ? { cacheWrite: normalizeMoney(input.cacheWrite, `${field}.cacheWrite`) }
      : {}),
    ...(normalizeMoney(input.total, `${field}.total`) !== undefined
      ? { total: normalizeMoney(input.total, `${field}.total`) }
      : {}),
    currency: normalizeCurrency(input.currency, `${field}.currency`),
  };
}

function estimateCost(
  usage: ModelUsageTokenBuckets,
  rates: ModelUsageCostRates | undefined,
): ModelUsageCostBreakdown {
  if (!rates) return {};
  const estimated: ModelUsageCostBreakdown = {
    currency: normalizeCurrency(rates.currency, 'estimatedRates.currency'),
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
    const component = roundModelUsageUsd((tokens / 1_000_000) * rate);
    estimated[bucket.cost] = component;
    total += component;
  }

  if (allBillableBucketsKnown) {
    estimated.total = roundModelUsageUsd(total);
  }
  return estimated;
}

function reconcileCompleteCostTotal(
  cost: ModelUsageCostBreakdown,
  usage: ModelUsageTokenBuckets,
  field: string,
): ModelUsageCostBreakdown {
  const hasComponents = COST_BUCKETS.some(bucket => cost[bucket.cost] !== undefined);
  if (!hasComponents) return cost;
  const completed = { ...cost };
  let total = 0;
  let allBillableBucketsKnown = true;
  for (const bucket of COST_BUCKETS) {
    const component = cost[bucket.cost];
    if (component !== undefined) {
      total += component;
      continue;
    }
    if (usage[bucket.tokens] > 0) {
      allBillableBucketsKnown = false;
      continue;
    }
    completed[bucket.cost] = 0;
  }
  const componentTotal = roundModelUsageUsd(total);
  if (!allBillableBucketsKnown && cost.total !== undefined && componentTotal > roundModelUsageUsd(cost.total)) {
    throw new Error(
      `${field} known component total (${componentTotal}) must not exceed ${field}.total (${roundModelUsageUsd(cost.total)})`,
    );
  }
  if (!allBillableBucketsKnown) return completed;
  if (cost.total !== undefined && roundModelUsageUsd(cost.total) !== componentTotal) {
    throw new Error(`${field}.total must equal the fully allocated component total (${componentTotal})`);
  }
  completed.total = cost.total ?? componentTotal;
  return completed;
}

function costBreakdownsEqual(
  left: ModelUsageCostBreakdown,
  right: ModelUsageCostBreakdown,
): boolean {
  return COST_BUCKETS.every(bucket => left[bucket.cost] === right[bucket.cost])
    && left.total === right.total
    && left.currency === right.currency;
}

export function reconcileModelUsageAccounting(
  input: ReconcileModelUsageAccountingInput,
): ReconciledModelUsageAccounting {
  const usage = normalizeUsage(input.usage);
  const normalizedProviderCost = normalizeCost(input.providerCost, 'providerCost');
  const providerCost = input.providerCost
    ? reconcileCompleteCostTotal(normalizedProviderCost, usage, 'providerCost')
    : normalizedProviderCost;
  if (input.estimatedCost && input.estimatedRates) {
    throw new Error('Provide estimatedCost or estimatedRates, not both');
  }
  const estimatedCost = input.estimatedCost
    ? reconcileCompleteCostTotal(normalizeCost(input.estimatedCost, 'estimatedCost'), usage, 'estimatedCost')
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
    ? reconcileCompleteCostTotal(normalizeCost(input.effectiveCost, 'effectiveCost'), usage, 'effectiveCost')
    : resolvedEffectiveCost;
  if (!costBreakdownsEqual(effectiveCost, resolvedEffectiveCost)) {
    const selectedSource = resolvedCostSource === 'none' ? 'resolved' : resolvedCostSource;
    throw new Error(`effectiveCost must exactly match the selected ${selectedSource} cost`);
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
