import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CorrelationMetadata, ModelBudgetBlockedEvent, ModelBudgetBlockReason, ModelBudgetWindowSnapshot, ModelRegistryEntry, ModelUsageLedgerRecord } from '../../shared/contracts/runtime.js';
import {
  reconcileModelUsageAccounting,
  type ModelUsageCostRates,
} from '../../shared/telemetry/model-usage-accounting.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import type { RoutingCandidate, RoutingPurpose } from './routing.js';

export const MODEL_USAGE_LEDGER_FILE_NAME = 'model-usage.json';

const MODEL_USAGE_LEDGER_SCHEMA_VERSION = 1 as const;

interface ModelUsageLedger {
  schemaVersion: typeof MODEL_USAGE_LEDGER_SCHEMA_VERSION;
  records: ModelUsageLedgerRecord[];
}

export interface ModelUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd: number;
}

export interface ModelUsageSnapshot {
  dayKey: string;
  monthKey: string;
  dailyTotals: ModelUsageTotals;
  monthlyTotals: ModelUsageTotals;
  totalsByModel: Record<string, ModelUsageTotals>;
  totalsByServiceProcess: Record<string, ModelUsageTotals>;
}

export interface RecordModelUsageParams {
  candidate: RoutingCandidate;
  purpose: RoutingPurpose;
  service: string;
  process: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  correlation?: Partial<CorrelationMetadata>;
  nowMs?: number;
}

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
}

export class ModelBudgetExceededError extends Error {
  readonly code = 'model_budget_blocked';
  readonly event: ModelBudgetBlockedEvent;

  constructor(event: ModelBudgetBlockedEvent) {
    super(`Model budget blocked candidate ${event.provider}:${event.model} (${event.reason})`);
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

function toNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
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

function cloneTotals(source?: ModelUsageTotals): ModelUsageTotals {
  return source
    ? { ...source }
    : {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      };
}

function mergeTotals(
  target: ModelUsageTotals,
  record: Pick<
    ModelUsageLedgerRecord,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'estimatedCostUsd'
  >,
): void {
  target.calls += 1;
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (record.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (record.cacheWriteTokens ?? 0);
  target.estimatedCostUsd += record.estimatedCostUsd;
}

function ensureObjectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid model usage ledger at ${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function validateModelUsageRecord(value: unknown, index: number): ModelUsageLedgerRecord {
  const path = `modelUsage.records[${index}]`;
  const record = ensureObjectRecord(value, path);
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) throw new Error(`Invalid model usage ledger at ${path}.id: expected non-empty string`);

  const timestampMs = toNonNegativeInteger(record.timestampMs);
  const dayKey = typeof record.dayKey === 'string' ? record.dayKey : '';
  const monthKey = typeof record.monthKey === 'string' ? record.monthKey : '';
  const provider = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
  const service = typeof record.service === 'string' ? record.service.trim() : '';
  const process = typeof record.process === 'string' ? record.process.trim() : '';
  const inputTokens = toNonNegativeInteger(record.inputTokens);
  const outputTokens = toNonNegativeInteger(record.outputTokens);
  const cacheReadTokens = toNonNegativeInteger(record.cacheReadTokens);
  const cacheWriteTokens = toNonNegativeInteger(record.cacheWriteTokens);
  const estimatedCostUsd = typeof record.estimatedCostUsd === 'number' && Number.isFinite(record.estimatedCostUsd) && record.estimatedCostUsd >= 0
    ? record.estimatedCostUsd
    : 0;

  if (!timestampMs) throw new Error(`Invalid model usage ledger at ${path}.timestampMs: expected positive integer`);
  if (!dayKey) throw new Error(`Invalid model usage ledger at ${path}.dayKey: expected non-empty string`);
  if (!monthKey) throw new Error(`Invalid model usage ledger at ${path}.monthKey: expected non-empty string`);
  if (!provider) throw new Error(`Invalid model usage ledger at ${path}.provider: expected non-empty string`);
  if (!model) throw new Error(`Invalid model usage ledger at ${path}.model: expected non-empty string`);
  if (!purpose) throw new Error(`Invalid model usage ledger at ${path}.purpose: expected non-empty string`);
  if (!service) throw new Error(`Invalid model usage ledger at ${path}.service: expected non-empty string`);
  if (!process) throw new Error(`Invalid model usage ledger at ${path}.process: expected non-empty string`);

  return {
    id,
    timestampMs,
    dayKey,
    monthKey,
    provider,
    model,
    ...(typeof record.slotKey === 'string' && record.slotKey.trim() ? { slotKey: record.slotKey.trim() } : {}),
    purpose,
    service,
    process,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCostUsd,
  };
}

function validateLedger(raw: unknown, path: string): ModelUsageLedger {
  const value = ensureObjectRecord(raw, path);
  if (value.schemaVersion !== MODEL_USAGE_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `Invalid model usage ledger at ${path}.schemaVersion: expected ${MODEL_USAGE_LEDGER_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(value.records)) {
    throw new Error(`Invalid model usage ledger at ${path}.records: expected array`);
  }

  return {
    schemaVersion: MODEL_USAGE_LEDGER_SCHEMA_VERSION,
    records: value.records.map((entry, index) => validateModelUsageRecord(entry, index)),
  };
}

function makeDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function makeMonthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
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
    if (!byId) return undefined;
    if (byId.enabled === false) return undefined;
    if (purpose && !byId.purposes.some(tag => tag.purpose === purpose)) return undefined;
    return toModelKey(byId.identity.provider, byId.identity.model)
      === toModelKey(identity.provider, identity.model)
      ? byId
      : undefined;
  }

  const candidateKey = toModelKey(identity.provider, identity.model);
  const matches = registry.models.filter(
    (entry) => entry.enabled !== false
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
  if (currency !== 'USD') {
    return null;
  }

  const inputRate = toPositiveNumber(entry.cost?.inputPer1MUsd);
  const outputRate = toPositiveNumber(entry.cost?.outputPer1MUsd);
  if (inputRate === undefined && outputRate === undefined) {
    return null;
  }
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
  const entry = resolveRegistryEntryForIdentity(config, candidate, purpose);
  return resolveCostRatesForEntry(entry);
}

export function resolveModelUsageCostRatesForIdentity(
  config: SubstrateConfig,
  identity: ModelUsagePricingIdentity,
): ModelUsageCostRates | undefined {
  const entry = resolveRegistryEntryForIdentity(config, identity);
  return resolveCostRatesForEntry(entry);
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

function toWindowSnapshot(
  nowMs: number,
  usage: ModelUsageSnapshot,
  dailyLimitUsd: number,
  monthlyLimitUsd: number,
): ModelBudgetWindowSnapshot {
  return {
    dayKey: makeDayKey(nowMs),
    monthKey: makeMonthKey(nowMs),
    dailySpentUsd: usage.dailyTotals.estimatedCostUsd,
    dailyLimitUsd,
    monthlySpentUsd: usage.monthlyTotals.estimatedCostUsd,
    monthlyLimitUsd,
  };
}

function buildBlockedEvent(
  reason: ModelBudgetBlockReason,
  nowMs: number,
  candidate: RoutingCandidate,
  purpose: RoutingPurpose,
  service: string,
  process: string,
  estimatedRequestCostUsd: number,
  snapshot: ModelBudgetWindowSnapshot,
  correlation?: Partial<CorrelationMetadata>,
): ModelBudgetBlockedEvent {
  return {
    timestampMs: nowMs,
    reason,
    purpose: sanitizePurpose(purpose),
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
    service: sanitizeService(service),
    process: sanitizeProcess(process),
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
  private readonly ledgerPath: string;
  private cachedLedger: ModelUsageLedger | null = null;
  private cachedLedgerMtimeMs = 0;

  constructor(private readonly config: SubstrateConfig) {
    this.ledgerPath = join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME);
  }

  requiresPreflightEstimate(): boolean {
    return this.config.modelRegistry?.budgetPolicy?.enabled === true;
  }

  getUsageSnapshot(nowMs = Date.now()): ModelUsageSnapshot {
    const ledger = this.loadLedger();
    const dayKey = makeDayKey(nowMs);
    const monthKey = makeMonthKey(nowMs);
    const dailyTotals = cloneTotals();
    const monthlyTotals = cloneTotals();
    const totalsByModel: Record<string, ModelUsageTotals> = {};
    const totalsByServiceProcess: Record<string, ModelUsageTotals> = {};

    for (const record of ledger.records) {
      const modelKey = `${record.provider}:${record.model}`;
      const processKey = `${record.service}:${record.process}`;
      const modelTotals = totalsByModel[modelKey] ?? cloneTotals();
      const processTotals = totalsByServiceProcess[processKey] ?? cloneTotals();
      mergeTotals(modelTotals, record);
      mergeTotals(processTotals, record);
      totalsByModel[modelKey] = modelTotals;
      totalsByServiceProcess[processKey] = processTotals;

      if (record.dayKey === dayKey) {
        mergeTotals(dailyTotals, record);
      }
      if (record.monthKey === monthKey) {
        mergeTotals(monthlyTotals, record);
      }
    }

    return {
      dayKey,
      monthKey,
      dailyTotals,
      monthlyTotals,
      totalsByModel,
      totalsByServiceProcess,
    };
  }

  evaluatePreflight(params: BudgetPreflightParams): BudgetPreflightResult {
    const nowMs = params.nowMs ?? Date.now();
    const policy = this.config.modelRegistry?.budgetPolicy;
    if (!this.requiresPreflightEstimate() || !policy) {
      return {
        allowed: true,
        estimatedRequestCostUsd: 0,
        snapshot: null,
      };
    }

    const usage = this.getUsageSnapshot(nowMs);
    const snapshot = toWindowSnapshot(nowMs, usage, policy.dailyUsdLimit, policy.monthlyUsdLimit);
    const entry = resolveRegistryEntryForIdentity(this.config, params.candidate, params.purpose);
    const rates = resolveUsdCostRates(entry);
    const estimatedInputTokens = Math.max(0, Math.floor(params.estimatedInputTokens));
    const estimatedOutputTokens = Math.max(
      0,
      Math.floor(params.estimatedOutputTokens ?? params.candidate.maxTokens),
    );

    if (!rates) {
      const blocked = buildBlockedEvent(
        'missing_cost_metadata',
        nowMs,
        params.candidate,
        params.purpose,
        params.service,
        params.process,
        0,
        snapshot,
        params.correlation,
      );
      return {
        allowed: false,
        estimatedRequestCostUsd: 0,
        snapshot,
        blockedEvent: blocked,
      };
    }

    const estimatedRequestCostUsd = estimateCostUsd(estimatedInputTokens, estimatedOutputTokens, rates);
    const projectedDaily = snapshot.dailySpentUsd + estimatedRequestCostUsd;
    if (projectedDaily > snapshot.dailyLimitUsd) {
      const blocked = buildBlockedEvent(
        'daily_budget_exceeded',
        nowMs,
        params.candidate,
        params.purpose,
        params.service,
        params.process,
        estimatedRequestCostUsd,
        snapshot,
        params.correlation,
      );
      return {
        allowed: false,
        estimatedRequestCostUsd,
        snapshot,
        blockedEvent: blocked,
      };
    }

    const projectedMonthly = snapshot.monthlySpentUsd + estimatedRequestCostUsd;
    if (projectedMonthly > snapshot.monthlyLimitUsd) {
      const blocked = buildBlockedEvent(
        'monthly_budget_exceeded',
        nowMs,
        params.candidate,
        params.purpose,
        params.service,
        params.process,
        estimatedRequestCostUsd,
        snapshot,
        params.correlation,
      );
      return {
        allowed: false,
        estimatedRequestCostUsd,
        snapshot,
        blockedEvent: blocked,
      };
    }

    return {
      allowed: true,
      estimatedRequestCostUsd,
      snapshot,
    };
  }

  recordUsage(params: RecordModelUsageParams): ModelUsageLedgerRecord {
    const nowMs = params.nowMs ?? Date.now();
    const ledger = this.loadLedger();
    const inputTokens = Math.max(0, Math.floor(params.inputTokens));
    const outputTokens = Math.max(0, Math.floor(params.outputTokens));
    const cacheReadTokens = Math.max(0, Math.floor(params.cacheReadTokens ?? 0));
    const cacheWriteTokens = Math.max(0, Math.floor(params.cacheWriteTokens ?? 0));
    const accountingRates = resolveModelUsageCostRates(this.config, params.candidate, params.purpose);
    const accounting = reconcileModelUsageAccounting({
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      ...(accountingRates ? { estimatedRates: accountingRates } : {}),
    });
    const estimatedCostUsd = accounting.estimatedCost.total ?? 0;

    const record: ModelUsageLedgerRecord = {
      id: `${nowMs}-${Math.random().toString(16).slice(2, 12)}`,
      timestampMs: nowMs,
      dayKey: makeDayKey(nowMs),
      monthKey: makeMonthKey(nowMs),
      provider: params.candidate.provider.trim().toLowerCase(),
      model: normalizeModelIdForProvider(params.candidate.provider, params.candidate.model),
      ...(params.candidate.slotKey ? { slotKey: params.candidate.slotKey } : {}),
      purpose: sanitizePurpose(params.purpose),
      service: sanitizeService(params.service),
      process: sanitizeProcess(params.process),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estimatedCostUsd,
    };

    ledger.records.push(record);
    this.saveLedger(ledger);
    return record;
  }

  private loadLedger(): ModelUsageLedger {
    if (!existsSync(this.ledgerPath)) {
      this.cachedLedger = null;
      this.cachedLedgerMtimeMs = 0;
      return {
        schemaVersion: MODEL_USAGE_LEDGER_SCHEMA_VERSION,
        records: [],
      };
    }
    const mtimeMs = statSync(this.ledgerPath).mtimeMs;
    if (this.cachedLedger && mtimeMs <= this.cachedLedgerMtimeMs) {
      return this.cachedLedger;
    }
    const raw = JSON.parse(readFileSync(this.ledgerPath, 'utf-8')) as unknown;
    const ledger = validateLedger(raw, this.ledgerPath);
    this.cachedLedger = ledger;
    this.cachedLedgerMtimeMs = mtimeMs;
    return ledger;
  }

  private saveLedger(ledger: ModelUsageLedger): void {
    writeJsonAtomic(this.ledgerPath, ledger);
    if (existsSync(this.ledgerPath)) {
      this.cachedLedgerMtimeMs = statSync(this.ledgerPath).mtimeMs;
      this.cachedLedger = ledger;
    }
  }
}
