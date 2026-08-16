import type { Pool } from 'pg';
import { queryOne, queryRows } from '../../postgres.js';
import type {
  FleetModelUsageQuery,
  FleetModelUsageSummary,
  ModelUsageAttributionCoverage,
  ModelUsageBreakdown,
  ModelUsageBudgetSpendSnapshot,
  ModelUsageBudgetPricingRate,
  ModelUsageBudgetScope,
  ModelUsageCostHydrationBreakdown,
  ModelUsageCostHydrationData,
  ModelUsageData,
  ModelUsageDimensionTimeBucket,
  ModelUsageExportData,
  ModelUsageEvent,
  ModelUsageGroup,
  ModelUsageGroupDimension,
  ModelUsageQuery,
  ModelUsageReconciliationQuery,
  ModelUsageResolvedRange,
  ModelUsageTimeBucket,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import {
  MODEL_USAGE_GROUP_DIMENSIONS,
  MODEL_USAGE_UNKNOWN_DIMENSION,
} from '../../../shared/telemetry/model-usage-attribution.js';
import { roundModelUsageUsd } from '../../../shared/telemetry/model-usage-accounting.js';
import {
  createModelUsageBucketBoundaries,
  resolveModelUsageRange,
  resolvePreviousModelUsagePeriod,
} from '../../../shared/telemetry/model-usage-range.js';
import { isRfc4122Uuid } from '../../../shared/utils/types.js';
import {
  dayKey,
  inputNonNegativeInteger,
  monthKey,
  nonNegativeCost,
  nonNegativeInteger,
} from './common.js';
import type {
  BreakdownRow,
  BudgetSpendRow,
  CostHydrationBreakdownRow,
  CoverageRow,
  DimensionTimeBucketRow,
  FleetAllTokenTotalsRow,
  FleetTokenTotalsRow,
  GroupRow,
  ModelUsageEventRow,
  PreparedModelUsageQuery,
  SqlWhere,
  TotalsRow,
} from './rows.js';
import {
  DEFAULT_TOP_N,
  GROUP_DIMENSION_SET,
  appendCompanionAllowlist,
  buildWhere,
  normalizeLimit,
  normalizeModelUsageBudgetPricing,
  normalizeQuery,
  normalizeQueryText,
} from './query-input.js';
import {
  MODEL_USAGE_AGGREGATE_SQL,
  MODEL_USAGE_DIMENSION_SQL,
  addFleetTokenTotals,
  addModelUsageTotals,
  appendEventCursor,
  attributionAnomaliesFromCoverage,
  decodeEventCursor,
  emptyModelUsageTotals,
  encodeEventCursor,
  groupComparator,
  mapBreakdown,
  mapEventRow,
  mapExportRow,
  mapFleetTokenTotals,
  mapTotals,
} from './query-support.js';

const DEFAULT_BREAKDOWN_LIMIT = 20;
const MAX_EXPORT_ROWS = 50_000;
const MAX_DIMENSION_TIME_SERIES_ROWS = 5_000;

export class PostgresModelUsageQueries {
  constructor(
    private readonly pool: Pool,
    private readonly companionId: string | undefined,
    private readonly waitUntilReady: () => Promise<void>,
  ) {}

  async getUsageData(query: ModelUsageQuery = {}): Promise<ModelUsageData> {
    await this.waitUntilReady();
    const prepared = await this.prepareQuery(query);
    const { query: normalizedQuery, resolvedRange, where } = prepared;
    const groupedByDimensions = normalizedQuery.groupBy ?? [];
    const seriesDimensions = [...new Set<ModelUsageGroupDimension>([
      'model',
      ...groupedByDimensions.slice(0, 1),
    ])];
    const previousPeriod = resolvePreviousModelUsagePeriod(resolvedRange);
    const previousWhere = previousPeriod
      ? buildWhere({
          ...normalizedQuery,
          sinceMs: previousPeriod.sinceMs,
          untilMs: previousPeriod.untilMs,
        })
      : undefined;
    const [
      totals,
      timeSeries,
      groups,
      eventPage,
      byModel,
      byPurpose,
      byTool,
      byCallKind,
      recentEvents,
      expensiveEvents,
      attributionCoverage,
      groupedByEntries,
      seriesByDimensionEntries,
      previousTotals,
    ] = await Promise.all([
      this.queryTotals(where),
      this.queryTimeSeries(where, resolvedRange),
      this.queryGroups(where, normalizedQuery),
      this.queryEventPage(where, normalizedQuery),
      this.queryBreakdown(where, "provider || ':' || model"),
      this.queryBreakdown(where, 'purpose'),
      this.queryBreakdown(where, 'tool_name'),
      this.queryBreakdown(where, 'call_kind'),
      this.queryEvents(where, normalizedQuery.limit, 'recorded_at_ms DESC, id DESC'),
      this.queryEvents(where, normalizedQuery.limit, 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC, id DESC'),
      this.queryAttributionCoverage(where),
      Promise.all(groupedByDimensions.map(async dimension => [
        dimension,
        await this.queryBreakdown(where, MODEL_USAGE_DIMENSION_SQL[dimension]),
      ] as const)),
      Promise.all(seriesDimensions.map(async dimension => [
        dimension,
        await this.queryTimeSeries(where, resolvedRange, dimension),
      ] as const)),
      previousWhere
        ? this.queryTotals(previousWhere)
        : Promise.resolve<ModelUsageTotals | undefined>(undefined),
    ]);
    return {
      query: normalizedQuery,
      resolvedRange,
      totals,
      ...(previousPeriod && previousTotals
        ? { previousPeriod: { ...previousPeriod, totals: previousTotals } }
        : {}),
      timeSeries,
      seriesByDimension: Object.fromEntries(seriesByDimensionEntries),
      groups,
      eventPage,
      byModel,
      byPurpose,
      byTool,
      byCallKind,
      groupedBy: Object.fromEntries(groupedByEntries),
      attributionCoverage,
      attributionAnomalies: attributionAnomaliesFromCoverage(attributionCoverage),
      recentEvents,
      expensiveEvents,
    };
  }

  async getUsageEventsForReconciliation(
    query: ModelUsageReconciliationQuery = {},
  ): Promise<ModelUsageEvent[]> {
    await this.waitUntilReady();
    const normalizedQuery = normalizeQuery(query, this.companionId);
    return await this.queryAllEvents(buildWhere(normalizedQuery));
  }

  async getUsageCostHydrationData(
    query: ModelUsageQuery = {},
    dimensions: readonly ModelUsageGroupDimension[],
  ): Promise<ModelUsageCostHydrationData> {
    await this.waitUntilReady();
    const { where } = await this.prepareQuery(query);
    const uniqueDimensions = [...new Set(dimensions.map((dimension) => {
      if (typeof dimension !== 'string' || !GROUP_DIMENSION_SET.has(dimension)) {
        throw new Error(`Cost hydration has unsupported dimension ${JSON.stringify(dimension)}`);
      }
      return dimension;
    }))];
    const entries = await Promise.all(uniqueDimensions.map(async dimension => [
      dimension,
      await this.queryCostHydrationBreakdown(where, dimension),
    ] as const));
    return { byDimension: Object.fromEntries(entries) };
  }

  async exportUsageEvents(query: ModelUsageQuery = {}): Promise<ModelUsageExportData> {
    await this.waitUntilReady();
    const prepared = await this.prepareQuery({ ...query, cursor: undefined });
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${prepared.where.clause}
      ORDER BY recorded_at_ms ASC, id ASC
      LIMIT ${MAX_EXPORT_ROWS + 1}
    `, prepared.where.values);
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new Error(`Model usage export exceeds the ${MAX_EXPORT_ROWS} row safety limit`);
    }
    return {
      query: prepared.query,
      resolvedRange: prepared.resolvedRange,
      rows: rows.map(row => mapExportRow(mapEventRow(row))),
    };
  }

  private async prepareQuery(
    query: ModelUsageQuery,
    nowMs = Date.now(),
    companionIds?: readonly string[],
  ): Promise<PreparedModelUsageQuery> {
    const normalizedQuery = normalizeQuery(query, this.companionId);
    let allSinceMs: number | undefined;
    if ((normalizedQuery.range ?? 'all') === 'all') {
      const baseUnboundedWhere = buildWhere({
        ...normalizedQuery,
        sinceMs: undefined,
        untilMs: undefined,
      });
      const unboundedWhere = companionIds
        ? appendCompanionAllowlist(baseUnboundedWhere, companionIds)
        : baseUnboundedWhere;
      const earliest = await queryOne<{ earliest_ms: number | string | null }>(this.pool, `
        SELECT MIN(recorded_at_ms) AS earliest_ms
        FROM model_usage_events
        ${unboundedWhere.clause}
      `, unboundedWhere.values);
      if (earliest?.earliest_ms !== null && earliest?.earliest_ms !== undefined) {
        allSinceMs = nonNegativeInteger(earliest.earliest_ms);
      }
    }
    const resolvedRange = resolveModelUsageRange(normalizedQuery, {
      nowMs,
      ...(allSinceMs !== undefined ? { allSinceMs } : {}),
    });
    const canonicalQuery: ModelUsageQuery = {
      ...normalizedQuery,
      range: resolvedRange.range,
      timezone: resolvedRange.timezone,
    };
    const baseWhere = buildWhere({
      ...canonicalQuery,
      sinceMs: resolvedRange.sinceMs,
      untilMs: resolvedRange.untilMs,
    });
    const where = companionIds
      ? appendCompanionAllowlist(baseWhere, companionIds)
      : baseWhere;
    return { query: canonicalQuery, resolvedRange, where };
  }

  async getFleetModelUsageSummary(
    query: FleetModelUsageQuery,
    companionIds: readonly string[],
    nowMs = Date.now(),
  ): Promise<FleetModelUsageSummary> {
    await this.waitUntilReady();
    if (this.companionId !== undefined) {
      throw new Error('Fleet model-usage summary requires the fleet-scoped model usage store');
    }
    const allowedQueryFields = new Set(['range', 'timezone', 'sinceMs', 'untilMs']);
    if (Object.keys(query).some(field => !allowedQueryFields.has(field))) {
      throw new Error('Fleet model-usage summary query contains unsupported fields');
    }
    if (companionIds.length === 0 || companionIds.length > 256) {
      throw new Error('Fleet model-usage summary requires 1-256 authorized companions');
    }
    const authorizedCompanionIds = [...companionIds];
    if (authorizedCompanionIds.some(companionId => !isRfc4122Uuid(companionId))) {
      throw new Error('Fleet model-usage summary companion IDs must be RFC-4122 UUIDs');
    }
    if (new Set(authorizedCompanionIds).size !== authorizedCompanionIds.length) {
      throw new Error('Fleet model-usage summary companion IDs must be unique');
    }
    authorizedCompanionIds.sort((left, right) => left.localeCompare(right));
    const now = inputNonNegativeInteger(nowMs, 'nowMs');
    const normalizedQuery = normalizeQuery(query);
    let resolvedRange: ModelUsageResolvedRange;
    let rows: FleetTokenTotalsRow[];
    const allRangeRequested = normalizedQuery.range === 'all'
      || (normalizedQuery.range === undefined
        && normalizedQuery.sinceMs === undefined
        && normalizedQuery.untilMs === undefined);
    if (allRangeRequested) {
      const preliminaryRange = resolveModelUsageRange(normalizedQuery, { nowMs: now });
      const allRows = await queryRows<FleetAllTokenTotalsRow>(this.pool, `
        WITH authorized_companions AS (
          SELECT UNNEST($1::text[]) AS companion_id
        ),
        fleet_events AS (
          SELECT event.*
          FROM model_usage_events AS event
          INNER JOIN authorized_companions USING (companion_id)
          WHERE event.recorded_at_ms < $2
        ),
        fleet_bounds AS (
          SELECT MIN(recorded_at_ms) AS earliest_ms
          FROM fleet_events
        )
        SELECT
          authorized.companion_id,
          COUNT(event.id) AS calls,
          COALESCE(SUM(event.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(event.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(event.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(event.cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(event.total_tokens), 0) AS total_tokens,
          bounds.earliest_ms
        FROM authorized_companions AS authorized
        CROSS JOIN fleet_bounds AS bounds
        LEFT JOIN fleet_events AS event USING (companion_id)
        GROUP BY authorized.companion_id, bounds.earliest_ms
        ORDER BY authorized.companion_id ASC
      `, [authorizedCompanionIds, preliminaryRange.untilMs]);
      const earliestMs = allRows.at(0)?.earliest_ms;
      resolvedRange = resolveModelUsageRange(normalizedQuery, {
        nowMs: now,
        ...(earliestMs !== null && earliestMs !== undefined
          ? { allSinceMs: nonNegativeInteger(earliestMs) }
          : {}),
      });
      rows = allRows;
    } else {
      const prepared = await this.prepareQuery(query, now, authorizedCompanionIds);
      resolvedRange = prepared.resolvedRange;
      rows = await queryRows<FleetTokenTotalsRow>(this.pool, `
        SELECT
          companion_id,
          COUNT(*) AS calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM model_usage_events
        ${prepared.where.clause}
        GROUP BY companion_id
        ORDER BY companion_id ASC
      `, prepared.where.values);
    }
    const byCompanionId = new Map(rows.map(row => [row.companion_id, row]));
    const companions = authorizedCompanionIds.map(companionId => ({
      companionId,
      usage: mapFleetTokenTotals(byCompanionId.get(companionId)),
    }));
    const combined = companions.reduce(
      (total, companion) => addFleetTokenTotals(total, companion.usage),
      mapFleetTokenTotals(),
    );
    return {
      resolvedRange,
      combined,
      companions,
    };
  }

  async getModelBudgetSpend(
    nowMs = Date.now(),
    scope?: ModelUsageBudgetScope,
    pricing: readonly ModelUsageBudgetPricingRate[] = [],
  ): Promise<ModelUsageBudgetSpendSnapshot> {
    const normalizedPricing = normalizeModelUsageBudgetPricing(pricing);
    await this.waitUntilReady();
    const now = inputNonNegativeInteger(nowMs, 'nowMs');
    const accountingStart = scope?.accountingStartMs === undefined
      ? undefined
      : inputNonNegativeInteger(scope.accountingStartMs, 'accountingStartMs');
    if (accountingStart !== undefined && !Number.isSafeInteger(accountingStart)) {
      throw new Error('accountingStartMs must be a non-negative safe integer');
    }
    if (accountingStart !== undefined && accountingStart > now) {
      throw new Error('accountingStartMs cannot be later than nowMs');
    }
    const requestedCompanionId = normalizeQueryText(scope?.companionId, 'companionId');
    if (this.companionId && requestedCompanionId && requestedCompanionId !== this.companionId) {
      throw new Error(
        `Model budget companionId ${JSON.stringify(requestedCompanionId)} does not match `
        + `the store tenant ${JSON.stringify(this.companionId)}`,
      );
    }
    const budgetCompanionId = this.companionId ?? requestedCompanionId;
    if (!budgetCompanionId) {
      throw new Error('Fleet model budget queries require an explicit companionId');
    }
    const nowDate = new Date(now);
    const day = dayKey(now);
    const month = monthKey(now);
    const windowDayStartMs = Date.parse(`${day}T00:00:00.000Z`);
    const windowMonthStartMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
    const dayStartMs = Math.max(windowDayStartMs, accountingStart ?? windowDayStartMs);
    const monthStartMs = Math.max(windowMonthStartMs, accountingStart ?? windowMonthStartMs);
    const serializedPricing = normalizedPricing.map(rate => ({
      slot_key: rate.slotKey,
      provider: rate.provider,
      model: rate.model,
      input_per_1m_usd: rate.inputPer1MUsd,
      output_per_1m_usd: rate.outputPer1MUsd,
      cache_read_per_1m_usd: rate.cacheReadPer1MUsd,
      cache_write_per_1m_usd: rate.cacheWritePer1MUsd,
    }));
    const row = await queryOne<BudgetSpendRow>(this.pool, `
      WITH pricing AS (
        SELECT *
        FROM jsonb_to_recordset($5::jsonb) AS rate(
          slot_key TEXT,
          provider TEXT,
          model TEXT,
          input_per_1m_usd NUMERIC,
          output_per_1m_usd NUMERIC,
          cache_read_per_1m_usd NUMERIC,
          cache_write_per_1m_usd NUMERIC
        )
      ), budget_events AS (
        SELECT
          event.recorded_at_ms,
          COALESCE(
            event.estimated_cost_usd,
            CASE WHEN event.status = 'success' AND rate.slot_key IS NOT NULL THEN
              (
                event.input_tokens * rate.input_per_1m_usd
                + event.output_tokens * rate.output_per_1m_usd
                + event.cache_read_tokens * rate.cache_read_per_1m_usd
                + event.cache_write_tokens * rate.cache_write_per_1m_usd
              ) / 1000000::NUMERIC
            END
          ) AS resolved_estimated_cost_usd
        FROM model_usage_events AS event
        LEFT JOIN pricing AS rate
          ON rate.slot_key = event.slot_key
          AND rate.provider = event.provider
          AND rate.model = event.model
        WHERE event.recorded_at_ms >= $2
          AND event.recorded_at_ms <= $3
          AND event.call_kind IN ('chat', 'completion')
          AND event.companion_id = $4
      )
      SELECT
        COALESCE(SUM(resolved_estimated_cost_usd) FILTER (
          WHERE recorded_at_ms >= $1
        ), 0) AS daily_estimated_cost_usd,
        COALESCE(SUM(resolved_estimated_cost_usd), 0) AS monthly_estimated_cost_usd,
        COUNT(*) FILTER (
          WHERE recorded_at_ms >= $1 AND resolved_estimated_cost_usd IS NULL
        ) AS daily_unknown_cost_attempts,
        COUNT(*) FILTER (
          WHERE resolved_estimated_cost_usd IS NULL
        ) AS monthly_unknown_cost_attempts
      FROM budget_events
    `, [dayStartMs, monthStartMs, now, budgetCompanionId, JSON.stringify(serializedPricing)]);
    return {
      dayKey: day,
      monthKey: month,
      dailyEstimatedCostUsd: roundModelUsageUsd(nonNegativeCost(row?.daily_estimated_cost_usd) ?? 0),
      monthlyEstimatedCostUsd: roundModelUsageUsd(nonNegativeCost(row?.monthly_estimated_cost_usd) ?? 0),
      dailyUnknownCostAttempts: nonNegativeInteger(row?.daily_unknown_cost_attempts),
      monthlyUnknownCostAttempts: nonNegativeInteger(row?.monthly_unknown_cost_attempts),
    };
  }

  private async queryTotals(where: SqlWhere): Promise<ModelUsageTotals> {
    const row = await queryOne<TotalsRow>(this.pool, `
      SELECT
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
    `, where.values);
    return mapTotals(row);
  }

  private async queryBreakdown(where: SqlWhere, expression: string): Promise<ModelUsageBreakdown[]> {
    const rows = await queryRows<BreakdownRow>(this.pool, `
      SELECT
        ${expression} AS key,
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY key
      ORDER BY total_cost_usd DESC, total_tokens DESC, calls DESC, key ASC
      LIMIT ${DEFAULT_BREAKDOWN_LIMIT}
    `, where.values);
    return rows.map(mapBreakdown);
  }

  private async queryTimeSeries(
    where: SqlWhere,
    range: ModelUsageResolvedRange,
  ): Promise<ModelUsageTimeBucket[]>;
  private async queryTimeSeries(
    where: SqlWhere,
    range: ModelUsageResolvedRange,
    dimension: ModelUsageGroupDimension,
  ): Promise<ModelUsageDimensionTimeBucket[]>;
  private async queryTimeSeries(
    where: SqlWhere,
    range: ModelUsageResolvedRange,
    dimension?: ModelUsageGroupDimension,
  ): Promise<ModelUsageTimeBucket[] | ModelUsageDimensionTimeBucket[]> {
    const timezoneParameter = where.values.length + 1;
    const bucketExpression = range.bucket === 'hour'
      ? 'FLOOR(recorded_at_ms / 3600000.0) * 3600000'
      : `EXTRACT(EPOCH FROM (date_trunc('${range.bucket}', to_timestamp(recorded_at_ms / 1000.0) AT TIME ZONE $${timezoneParameter}) AT TIME ZONE $${timezoneParameter})) * 1000`;
    const dimensionExpression = dimension === undefined
      ? undefined
      : dimension === 'model'
        ? "provider || ':' || model"
        : MODEL_USAGE_DIMENSION_SQL[dimension];
    const seriesSelection = dimensionExpression
      ? `,\n        ${dimensionExpression} AS series_key`
      : '';
    const seriesGrouping = dimensionExpression ? ', series_key' : '';
    const seriesLimit = dimensionExpression
      ? `\n      LIMIT ${MAX_DIMENSION_TIME_SERIES_ROWS + 1}`
      : '';
    const values = range.bucket === 'hour' ? where.values : [...where.values, range.timezone];
    const rows = await queryRows<DimensionTimeBucketRow>(this.pool, `
      SELECT
        ${bucketExpression} AS bucket_start_ms${seriesSelection},
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY bucket_start_ms${seriesGrouping}
      ORDER BY bucket_start_ms ASC${seriesGrouping}${seriesLimit}
    `, values);
    const boundaries = createModelUsageBucketBoundaries(range);
    if (dimension !== undefined) {
      if (rows.length > MAX_DIMENSION_TIME_SERIES_ROWS) {
        throw new Error(
          `Model usage dimension time series exceeds the `
          + `${MAX_DIMENSION_TIME_SERIES_ROWS}-row safety limit`,
        );
      }
      const endByStart = new Map(boundaries.map(boundary => (
        [boundary.startMs, boundary.endMs] as const
      )));
      return rows.map((row) => {
        const startMs = nonNegativeInteger(row.bucket_start_ms);
        const endMs = endByStart.get(startMs);
        if (endMs === undefined) {
          throw new Error(`Model usage series returned an out-of-range ${dimension} bucket`);
        }
        return {
          key: row.series_key?.trim() || MODEL_USAGE_UNKNOWN_DIMENSION,
          startMs,
          endMs,
          ...mapTotals(row),
        };
      });
    }
    const byStart = new Map(rows.map(row => [nonNegativeInteger(row.bucket_start_ms), mapTotals(row)]));
    return boundaries.map(boundary => ({
      startMs: boundary.startMs,
      endMs: boundary.endMs,
      ...emptyModelUsageTotals(),
      ...(byStart.get(boundary.startMs) ?? {}),
    }));
  }

  private async queryGroups(where: SqlWhere, query: ModelUsageQuery): Promise<ModelUsageGroup[]> {
    const dimensions = query.groupBy ?? [];
    if (dimensions.length === 0) return [];
    const expressions = dimensions.map(dimension => MODEL_USAGE_DIMENSION_SQL[dimension]);
    const rows = await queryRows<GroupRow>(this.pool, `
      SELECT
        ${expressions[0]} AS dimension_0,
        ${expressions[1] ?? 'NULL::text'} AS dimension_1,
        FALSE AS is_other,
        0 AS sort_rank,
        ${MODEL_USAGE_AGGREGATE_SQL}
      FROM model_usage_events
      ${where.clause}
      GROUP BY ${expressions.join(', ')}
      LIMIT 5001
    `, where.values);
    if (rows.length > 5_000) {
      throw new Error('Model usage grouping exceeds the 5000-group safety limit');
    }
    const groups = rows.map((row): ModelUsageGroup => ({
      dimensions: Object.fromEntries(dimensions.map((dimension, index) => [
        dimension,
        (index === 0 ? row.dimension_0 : row.dimension_1)?.trim() || MODEL_USAGE_UNKNOWN_DIMENSION,
      ])),
      isOther: false,
      metrics: mapTotals(row),
    }));
    groups.sort(groupComparator(query));
    const topN = query.topN ?? DEFAULT_TOP_N;
    if (groups.length <= topN) return groups;
    const visible = groups.slice(0, topN);
    const otherMetrics = groups.slice(topN).reduce(
      (total, group) => addModelUsageTotals(total, group.metrics),
      emptyModelUsageTotals(),
    );
    return [...visible, {
      dimensions: Object.fromEntries(dimensions.map(dimension => [dimension, 'Other'])),
      isOther: true,
      metrics: otherMetrics,
    }];
  }

  private async queryEventPage(where: SqlWhere, query: ModelUsageQuery): Promise<ModelUsageData['eventPage']> {
    const order = query.eventOrder ?? 'recent';
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor ? decodeEventCursor(query.cursor, query) : undefined;
    const cursorWhere = appendEventCursor(where, order, cursor);
    const orderBy = order === 'recent'
      ? 'recorded_at_ms DESC, id DESC'
      : 'COALESCE(effective_cost_usd, 0) DESC, recorded_at_ms DESC, id DESC';
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${cursorWhere.clause}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `, cursorWhere.values);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapEventRow);
    const last = items.at(-1);
    return {
      order,
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeEventCursor(last, order, query) : null,
    };
  }

  private async queryCostHydrationBreakdown(
    where: SqlWhere,
    dimension: ModelUsageGroupDimension,
  ): Promise<ModelUsageCostHydrationBreakdown[]> {
    const expression = MODEL_USAGE_DIMENSION_SQL[dimension];
    const rows = await queryRows<CostHydrationBreakdownRow>(this.pool, `
      SELECT
        ${expression} AS key,
        provider || ':' || model AS model_key,
        cost_source,
        COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(effective_cost_usd), 0) AS total_cost_usd
      FROM model_usage_events
      ${where.clause}
      GROUP BY key, model_key, cost_source
      ORDER BY key ASC, model_key ASC, cost_source ASC
    `, where.values);
    return rows.map(row => ({
      ...mapBreakdown(row),
      modelKey: row.model_key,
      costSource: row.cost_source,
    }));
  }

  private async queryAttributionCoverage(where: SqlWhere): Promise<ModelUsageAttributionCoverage> {
    const coverageColumns = MODEL_USAGE_GROUP_DIMENSIONS.flatMap((dimension, index) => {
      const expression = MODEL_USAGE_DIMENSION_SQL[dimension];
      return [
        `COUNT(*) FILTER (WHERE ${expression} <> '${MODEL_USAGE_UNKNOWN_DIMENSION}') AS known_${index}`,
        `COUNT(*) FILTER (WHERE ${expression} = '${MODEL_USAGE_UNKNOWN_DIMENSION}') AS unknown_${index}`,
      ];
    });
    const row = await queryOne<CoverageRow>(this.pool, `
      SELECT
        COUNT(*) AS total_calls,
        ${coverageColumns.join(',\n        ')}
      FROM model_usage_events
      ${where.clause}
    `, where.values);
    const totalCalls = nonNegativeInteger(row?.total_calls);
    return {
      totalCalls,
      byDimension: Object.fromEntries(MODEL_USAGE_GROUP_DIMENSIONS.map((dimension, index) => {
        const knownCalls = nonNegativeInteger(row?.[`known_${index}`]);
        const unknownCalls = nonNegativeInteger(row?.[`unknown_${index}`]);
        return [dimension, {
          knownCalls,
          unknownCalls,
          coveragePercent: totalCalls === 0 ? 0 : Math.round((knownCalls / totalCalls) * 10_000) / 100,
        }];
      })) as ModelUsageAttributionCoverage['byDimension'],
    };
  }

  private async queryEvents(where: SqlWhere, limit: number | undefined, orderBy: string): Promise<ModelUsageEvent[]> {
    const safeLimit = normalizeLimit(limit);
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${where.clause}
      ORDER BY ${orderBy}
      LIMIT ${safeLimit}
    `, where.values);
    return rows.map(mapEventRow);
  }

  private async queryAllEvents(where: SqlWhere): Promise<ModelUsageEvent[]> {
    const rows = await queryRows<ModelUsageEventRow>(this.pool, `
      SELECT *
      FROM model_usage_events
      ${where.clause}
      ORDER BY recorded_at_ms ASC, logical_call_id ASC, attempt ASC, id ASC
    `, where.values);
    return rows.map(mapEventRow);
  }
}
