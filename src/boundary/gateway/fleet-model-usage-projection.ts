import { randomUUID } from 'node:crypto';
import type {
  FleetModelUsageCompanionTotals,
  FleetModelUsageQuery,
  FleetModelUsageSummaryQueryPort,
  FleetModelUsageSummary,
  FleetModelUsageTokenTotals,
  ModelUsageResolvedRange,
} from '../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_BUCKETS,
  MODEL_USAGE_RANGES,
} from '../../shared/telemetry/model-usage.js';
import type { FleetPortalAuthorizationBatchPort } from './fleet-portal-authorization.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import { isRecord } from '../../shared/utils/types.js';

const TOKEN_TOTAL_FIELDS = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
] as const;
const RESOLVED_RANGE_FIELDS = [
  'range',
  'timezone',
  'sinceMs',
  'untilMs',
  'bucket',
  'boundary',
  'calendarWeekStartsOn',
] as const;

function hasExactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function validatedTokenTotals(value: unknown): FleetModelUsageTokenTotals {
  if (!isRecord(value) || !hasExactKeys(value, TOKEN_TOTAL_FIELDS)) {
    throw new Error('Fleet model-usage aggregate returned invalid token totals');
  }
  for (const field of TOKEN_TOTAL_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error('Fleet model-usage aggregate returned invalid token totals');
    }
  }
  const totals = Object.fromEntries(
    TOKEN_TOTAL_FIELDS.map(field => [field, value[field] as number]),
  ) as unknown as FleetModelUsageTokenTotals;
  if (!Object.is(
    totals.totalTokens,
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  )) {
    throw new Error('Fleet model-usage aggregate returned inconsistent token totals');
  }
  return totals;
}

function addTokenTotals(
  left: FleetModelUsageTokenTotals,
  right: FleetModelUsageTokenTotals,
): FleetModelUsageTokenTotals {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function validatedResolvedRange(value: unknown): ModelUsageResolvedRange {
  if (!isRecord(value)
    || !hasExactKeys(value, RESOLVED_RANGE_FIELDS)
    || typeof value.range !== 'string'
    || !MODEL_USAGE_RANGES.includes(value.range as ModelUsageResolvedRange['range'])
    || typeof value.timezone !== 'string'
    || value.timezone.length === 0
    || value.timezone.length > 128
    || !Number.isSafeInteger(value.sinceMs)
    || (value.sinceMs as number) < 0
    || !Number.isSafeInteger(value.untilMs)
    || (value.untilMs as number) < (value.sinceMs as number)
    || typeof value.bucket !== 'string'
    || !MODEL_USAGE_BUCKETS.includes(value.bucket as ModelUsageResolvedRange['bucket'])
    || value.bucket === 'auto'
    || value.boundary !== '[sinceMs, untilMs)'
    || value.calendarWeekStartsOn !== 'monday') {
    throw new Error('Fleet model-usage aggregate returned an invalid resolved range');
  }
  return {
    range: value.range as ModelUsageResolvedRange['range'],
    timezone: value.timezone,
    sinceMs: value.sinceMs as number,
    untilMs: value.untilMs as number,
    bucket: value.bucket as ModelUsageResolvedRange['bucket'],
    boundary: '[sinceMs, untilMs)',
    calendarWeekStartsOn: 'monday',
  };
}

function validatedSummary(
  value: FleetModelUsageSummary,
  companionIds: readonly string[],
): FleetModelUsageSummary {
  if (!Array.isArray(value.companions)
    || value.companions.length !== companionIds.length) {
    throw new Error('Fleet model-usage aggregate changed the authorized companion set');
  }
  const companions: FleetModelUsageCompanionTotals[] = value.companions.map((row, index) => {
    if (!isRecord(row)
      || !hasExactKeys(row, ['companionId', 'usage'])
      || row.companionId !== companionIds[index]) {
      throw new Error('Fleet model-usage aggregate changed the authorized companion set');
    }
    return {
      companionId: row.companionId,
      usage: validatedTokenTotals(row.usage),
    };
  });
  const zero = validatedTokenTotals({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  });
  const conserved = companions.reduce(
    (total, companion) => addTokenTotals(total, companion.usage),
    zero,
  );
  const combined = validatedTokenTotals(value.combined);
  if (TOKEN_TOTAL_FIELDS.some(field => !Object.is(combined[field], conserved[field]))) {
    throw new Error('Fleet model-usage combined totals do not conserve companion totals');
  }
  return {
    resolvedRange: validatedResolvedRange(value.resolvedRange),
    combined,
    companions,
  };
}

export interface FleetModelUsageProjection extends FleetModelUsageSummary {
  schemaVersion: 1;
  generatedAt: string;
}

export interface FleetModelUsageProjectionPort {
  resolve(input: {
    sessionToken: string;
    query: FleetModelUsageQuery;
  }): Promise<FleetModelUsageProjection>;
}

export interface FleetModelUsageAuthorizationPort {
  resolveAuthorizationContext(input: {
    sessionToken: string;
    audience: 'fleet';
    companionId: string;
    action: 'models.read';
    correlationId: string;
  }): Promise<unknown>;
}

export interface GatewayFleetModelUsageProjectionOptions {
  portalAuthorizer: FleetPortalAuthorizationBatchPort;
  modelAuthorizer: FleetModelUsageAuthorizationPort;
  usage: FleetModelUsageSummaryQueryPort;
  now?: () => Date;
}

export class GatewayFleetModelUsageProjection implements FleetModelUsageProjectionPort {
  private readonly now: () => Date;

  constructor(private readonly options: GatewayFleetModelUsageProjectionOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async resolve(input: {
    sessionToken: string;
    query: FleetModelUsageQuery;
  }): Promise<FleetModelUsageProjection> {
    const roster = await this.options.portalAuthorizer.resolve({
      sessionToken: input.sessionToken,
    });
    const authorized = await Promise.all(roster.companions.map(async ({ companionId }) => {
      try {
        const context = await this.options.modelAuthorizer.resolveAuthorizationContext({
          sessionToken: input.sessionToken,
          audience: 'fleet',
          companionId,
          action: 'models.read',
          correlationId: randomUUID(),
        });
        if (!isRecord(context)
          || context.companionId !== companionId
          || !isRecord(context.authorization)
          || context.authorization.action !== 'models.read'
          || context.authorization.decision !== 'allow') {
          throw new Error('Fleet model-usage authorization context changed target');
        }
        return companionId;
      } catch (error) {
        if (error instanceof FleetAuthorizationDeniedError
          && error.code === 'role_action_denied') {
          return null;
        }
        throw error;
      }
    }));
    const companionIds = authorized
      .filter((companionId): companionId is string => companionId !== null)
      .sort((left, right) => left.localeCompare(right));
    if (companionIds.length === 0) {
      throw new FleetAuthorizationDeniedError('role_action_denied');
    }

    const now = this.now();
    const generatedAt = now.toISOString();
    const summary = await this.options.usage.getFleetModelUsageSummary(
      input.query,
      companionIds,
      now.getTime(),
    );
    const validated = validatedSummary(summary, companionIds);
    return {
      schemaVersion: 1,
      generatedAt,
      ...validated,
    };
  }
}
