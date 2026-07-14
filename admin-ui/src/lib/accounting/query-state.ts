import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_EVENT_ORDERS,
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_GROUP_SORTS,
  MODEL_USAGE_RANGES,
  MODEL_USAGE_SORT_DIRECTIONS,
  type ModelUsageBucket,
  type ModelUsageEventOrder,
  type ModelUsageGroupDimension,
  type ModelUsageGroupSort,
  type ModelUsageQuery,
  type ModelUsageRange,
  type ModelUsageSortDirection,
} from '../../../../src/shared/telemetry/model-usage.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
} from '../../../../src/shared/contracts/charge-policy.js';
import type { ChargeCostReconciliationQuery } from '../../../../src/shared/telemetry/charge-cost-reconciliation-contracts.js';

export const ACCOUNTING_RANGE_OPTIONS = MODEL_USAGE_RANGES.map(value => ({
  value,
  label: value === 'all' ? 'All time' : `${value[0]?.toUpperCase()}${value.slice(1)}`,
}));

export const ACCOUNTING_DIMENSION_OPTIONS = MODEL_USAGE_GROUP_DIMENSIONS.map(value => ({
  value,
  label: value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, character => character.toUpperCase()),
}));

export interface AccountingQueryState {
  range: ModelUsageRange;
  timezone: string;
  customSinceDate: string;
  customUntilDate: string;
  bucket: ModelUsageBucket;
  groupBy: readonly ModelUsageGroupDimension[];
  sortBy: ModelUsageGroupSort;
  sortDirection: ModelUsageSortDirection;
  eventOrder: ModelUsageEventOrder;
  filters: Partial<Record<ModelUsageGroupDimension, string>>;
}

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u;
const GROUP_DIMENSIONS = new Set<string>(MODEL_USAGE_GROUP_DIMENSIONS);
const CHARGE_LANES = new Set<string>(CHARGE_POLICY_RUNTIME_LANE_VALUES);
const CHARGE_SURFACES = new Set<string>(CHARGE_POLICY_SURFACE_VALUES);

function isAllowed<T extends string>(value: string | null, allowed: readonly T[]): value is T {
  return value !== null && allowed.includes(value as T);
}

function validTimezone(value: string | null, fallback: string): string {
  const candidate = value?.trim() || fallback;
  if (candidate.length > 128 || CONTROL_CHARACTER.test(candidate)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return 'UTC';
  }
}

function dateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

function isDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return parsed.toISOString().slice(0, 10) === value;
}

/** Resolve midnight for a calendar date in an IANA timezone, including DST boundaries. */
export function zonedDateStartMs(date: string, timezone: string): number {
  if (!isDate(date)) throw new Error(`Invalid accounting date ${JSON.stringify(date)}.`);
  const safeTimezone = validTimezone(timezone, 'UTC');
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const correction = target - observed;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

export function createDefaultAccountingState(
  requestedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = new Date(),
): AccountingQueryState {
  const timezone = validTimezone(requestedTimezone, 'UTC');
  const today = dateInTimezone(now, timezone);
  return {
    range: 'month',
    timezone,
    customSinceDate: addCalendarDays(today, -6),
    customUntilDate: today,
    bucket: 'auto',
    groupBy: ['model'],
    sortBy: 'effectiveCostUsd',
    sortDirection: 'desc',
    eventOrder: 'expensive',
    filters: {},
  };
}

export function accountingStateFromSearchParams(
  params: URLSearchParams,
  fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = new Date(),
): AccountingQueryState {
  const timezone = validTimezone(params.get('timezone'), fallbackTimezone);
  const defaults = createDefaultAccountingState(timezone, now);
  const rawGroups = (params.get('groupBy') ?? '')
    .split(',')
    .map(value => value.trim())
    .filter((value, index, values) => GROUP_DIMENSIONS.has(value) && values.indexOf(value) === index)
    .slice(0, 2) as ModelUsageGroupDimension[];
  const filters: Partial<Record<ModelUsageGroupDimension, string>> = {};
  for (const dimension of MODEL_USAGE_GROUP_DIMENSIONS) {
    const value = params.get(`filter.${dimension}`)?.trim();
    if (value && value.length <= 512 && !CONTROL_CHARACTER.test(value)) filters[dimension] = value;
  }
  const range = params.get('range');
  const bucket = params.get('bucket');
  const sortBy = params.get('sortBy');
  const sortDirection = params.get('sortDirection');
  const eventOrder = params.get('eventOrder');
  return {
    range: isAllowed(range, MODEL_USAGE_RANGES) ? range : defaults.range,
    timezone,
    customSinceDate: isDate(params.get('since')) ? params.get('since') as string : defaults.customSinceDate,
    customUntilDate: isDate(params.get('until')) ? params.get('until') as string : defaults.customUntilDate,
    bucket: isAllowed(bucket, MODEL_USAGE_BUCKETS) ? bucket : defaults.bucket,
    groupBy: rawGroups.length > 0 ? rawGroups : defaults.groupBy,
    sortBy: isAllowed(sortBy, MODEL_USAGE_GROUP_SORTS) ? sortBy : defaults.sortBy,
    sortDirection: isAllowed(sortDirection, MODEL_USAGE_SORT_DIRECTIONS)
      ? sortDirection
      : defaults.sortDirection,
    eventOrder: isAllowed(eventOrder, MODEL_USAGE_EVENT_ORDERS) ? eventOrder : defaults.eventOrder,
    filters,
  };
}

export function accountingStateToSearchParams(state: AccountingQueryState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('tab', 'token-usage');
  params.set('range', state.range);
  params.set('timezone', state.timezone);
  params.set('since', state.customSinceDate);
  params.set('until', state.customUntilDate);
  params.set('bucket', state.bucket);
  params.set('groupBy', state.groupBy.join(','));
  params.set('sortBy', state.sortBy);
  params.set('sortDirection', state.sortDirection);
  params.set('eventOrder', state.eventOrder);
  for (const dimension of MODEL_USAGE_GROUP_DIMENSIONS) {
    const value = state.filters[dimension];
    if (value) params.set(`filter.${dimension}`, value);
  }
  return params;
}

export function buildModelUsageQuery(state: AccountingQueryState): ModelUsageQuery {
  const query: ModelUsageQuery = {
    range: state.range,
    timezone: state.timezone,
    bucket: state.bucket,
    groupBy: [...state.groupBy],
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    eventOrder: state.eventOrder,
    topN: 50,
    limit: 100,
  };
  if (state.range === 'custom') {
    query.sinceMs = zonedDateStartMs(state.customSinceDate, state.timezone);
    query.untilMs = zonedDateStartMs(addCalendarDays(state.customUntilDate, 1), state.timezone);
    if (query.sinceMs >= query.untilMs) {
      throw new Error('Custom accounting start date must be on or before the through date.');
    }
  }
  for (const dimension of MODEL_USAGE_GROUP_DIMENSIONS) {
    const value = state.filters[dimension];
    if (value) (query as Record<string, unknown>)[dimension] = value;
  }
  return query;
}

export function buildChargeCostQuery(
  state: AccountingQueryState,
  resolvedRange: { sinceMs: number; untilMs: number },
): ChargeCostReconciliationQuery {
  const filters = state.filters;
  const lane = filters.chargeLane;
  const surface = filters.chargeSurface;
  return {
    sinceMs: resolvedRange.sinceMs,
    untilMs: resolvedRange.untilMs,
    ...(filters.companionId ? { companionId: filters.companionId } : {}),
    ...(filters.channelId ? { channelId: filters.channelId } : {}),
    ...(lane && CHARGE_LANES.has(lane)
      ? { lane: lane as ChargeCostReconciliationQuery['lane'] }
      : {}),
    ...(surface && CHARGE_SURFACES.has(surface)
      ? { surface: surface as ChargeCostReconciliationQuery['surface'] }
      : {}),
    ...(filters.chargeRunId ? { runId: filters.chargeRunId } : {}),
    ...(filters.chargeRootRunId ? { rootRunId: filters.chargeRootRunId } : {}),
  };
}

const CHARGE_COST_FILTERS = new Set<ModelUsageGroupDimension>([
  'companionId',
  'channelId',
  'chargeLane',
  'chargeSurface',
  'chargeRunId',
  'chargeRootRunId',
]);

export function unsupportedChargeCostFilters(
  state: AccountingQueryState,
): ModelUsageGroupDimension[] {
  return MODEL_USAGE_GROUP_DIMENSIONS.filter(
    dimension => Boolean(state.filters[dimension]) && !CHARGE_COST_FILTERS.has(dimension),
  );
}
