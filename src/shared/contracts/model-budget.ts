import type {
  ModelBudgetBlockedEvent,
  ModelBudgetBlockReason,
  ModelBudgetWindowSnapshot,
  ObservabilityCallType,
} from './runtime.js';
import { isRecord } from '../utils/types.js';

export const MODEL_BUDGET_BLOCK_REASONS = [
  'daily_budget_exceeded',
  'monthly_budget_exceeded',
  'missing_cost_metadata',
  'accounting_unavailable',
  'unknown_historical_cost',
] as const satisfies readonly ModelBudgetBlockReason[];

const OBSERVABILITY_CALL_TYPES = [
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
] as const satisfies readonly ObservabilityCallType[];

const EVENT_KEYS = new Set([
  'timestampMs',
  'reason',
  'purpose',
  'provider',
  'model',
  'slotKey',
  'service',
  'process',
  'estimatedRequestCostUsd',
  'budget',
  'turnId',
  'requestId',
  'channelId',
  'toolName',
  'toolCallId',
  'callType',
  'originType',
  'originStage',
]);

const BUDGET_KEYS = new Set([
  'dayKey',
  'monthKey',
  'dailySpentUsd',
  'dailyLimitUsd',
  'monthlySpentUsd',
  'monthlyLimitUsd',
  'dailyUnknownCostAttempts',
  'monthlyUnknownCostAttempts',
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknownKeys = Object.keys(value).filter(key => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknownKeys.sort().join(', ')}`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function requireNonNegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const matched = typeof value === 'string'
    ? allowed.find(candidate => candidate === value)
    : undefined;
  if (matched === undefined) {
    throw new Error(`${label} is unsupported: ${String(value)}`);
  }
  return matched;
}

function requireDateKey(value: unknown, label: string): string {
  const normalized = requireNonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label} must be a valid UTC date`);
  }
  return normalized;
}

function requireMonthKey(value: unknown, label: string): string {
  const normalized = requireNonEmptyString(value, label);
  if (!/^\d{4}-\d{2}$/u.test(normalized)) {
    throw new Error(`${label} must use YYYY-MM format`);
  }
  const parsed = new Date(`${normalized}-01T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 7) !== normalized) {
    throw new Error(`${label} must be a valid UTC month`);
  }
  return normalized;
}

function parseBudgetWindow(value: unknown): ModelBudgetWindowSnapshot {
  const budget = requireRecord(value, 'Model budget blocked event.budget');
  assertNoUnknownKeys(budget, BUDGET_KEYS, 'Model budget blocked event.budget');
  const dayKey = requireDateKey(budget.dayKey, 'Model budget blocked event.budget.dayKey');
  const monthKey = requireMonthKey(budget.monthKey, 'Model budget blocked event.budget.monthKey');
  if (!dayKey.startsWith(`${monthKey}-`)) {
    throw new Error('Model budget blocked event budget dayKey and monthKey must describe the same month');
  }
  return {
    dayKey,
    monthKey,
    dailySpentUsd: requireNonNegativeFiniteNumber(
      budget.dailySpentUsd,
      'Model budget blocked event.budget.dailySpentUsd',
    ),
    dailyLimitUsd: requireNonNegativeFiniteNumber(
      budget.dailyLimitUsd,
      'Model budget blocked event.budget.dailyLimitUsd',
    ),
    monthlySpentUsd: requireNonNegativeFiniteNumber(
      budget.monthlySpentUsd,
      'Model budget blocked event.budget.monthlySpentUsd',
    ),
    monthlyLimitUsd: requireNonNegativeFiniteNumber(
      budget.monthlyLimitUsd,
      'Model budget blocked event.budget.monthlyLimitUsd',
    ),
    dailyUnknownCostAttempts: requireNonNegativeInteger(
      budget.dailyUnknownCostAttempts,
      'Model budget blocked event.budget.dailyUnknownCostAttempts',
    ),
    monthlyUnknownCostAttempts: requireNonNegativeInteger(
      budget.monthlyUnknownCostAttempts,
      'Model budget blocked event.budget.monthlyUnknownCostAttempts',
    ),
  };
}

/** Strict decoder for the model-budget JSON-RPC error payload. */
export function parseModelBudgetBlockedEvent(value: unknown): ModelBudgetBlockedEvent {
  const event = requireRecord(value, 'Model budget blocked event');
  assertNoUnknownKeys(event, EVENT_KEYS, 'Model budget blocked event');
  const callType = event.callType === undefined
    ? undefined
    : requireEnum(event.callType, OBSERVABILITY_CALL_TYPES, 'Model budget blocked event.callType');
  const originType = event.originType === undefined
    ? undefined
    : requireEnum(event.originType, OBSERVABILITY_CALL_TYPES, 'Model budget blocked event.originType');
  const slotKey = optionalNonEmptyString(event.slotKey, 'Model budget blocked event.slotKey');
  const turnId = optionalNonEmptyString(event.turnId, 'Model budget blocked event.turnId');
  const requestId = optionalNonEmptyString(event.requestId, 'Model budget blocked event.requestId');
  const channelId = optionalNonEmptyString(event.channelId, 'Model budget blocked event.channelId');
  const toolName = optionalNonEmptyString(event.toolName, 'Model budget blocked event.toolName');
  const toolCallId = optionalNonEmptyString(event.toolCallId, 'Model budget blocked event.toolCallId');
  const originStage = optionalNonEmptyString(event.originStage, 'Model budget blocked event.originStage');
  return {
    timestampMs: requireNonNegativeInteger(event.timestampMs, 'Model budget blocked event.timestampMs'),
    reason: requireEnum(event.reason, MODEL_BUDGET_BLOCK_REASONS, 'Model budget blocked event.reason'),
    purpose: requireNonEmptyString(event.purpose, 'Model budget blocked event.purpose'),
    provider: requireNonEmptyString(event.provider, 'Model budget blocked event.provider'),
    model: requireNonEmptyString(event.model, 'Model budget blocked event.model'),
    ...(slotKey ? { slotKey } : {}),
    service: requireNonEmptyString(event.service, 'Model budget blocked event.service'),
    process: requireNonEmptyString(event.process, 'Model budget blocked event.process'),
    estimatedRequestCostUsd: requireNonNegativeFiniteNumber(
      event.estimatedRequestCostUsd,
      'Model budget blocked event.estimatedRequestCostUsd',
    ),
    budget: parseBudgetWindow(event.budget),
    ...(turnId ? { turnId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(callType ? { callType } : {}),
    ...(originType ? { originType } : {}),
    ...(originStage ? { originStage } : {}),
  };
}
