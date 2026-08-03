import type { Pool } from 'pg';
import type {
  MemoryAdminListOptions,
  MemorySubjectAdminQuery,
  MemorySubjectAdminResult,
} from '../memory-store-port.js';
import {
  type AdminMemoryPrivacyAggregateRow,
  type MemoryRow,
  type SensitivityCountRow,
  fromMemoryRow,
  parsePgNumber,
} from './rows.js';
import { clampLimit } from './utils.js';
import { buildMemorySubjectAuthorizationPredicate } from './subject-policy.js';
import { MEMORY_SUBJECT_SELECT_COLUMNS } from './subject-queries.js';
import {
  ADMIN_DURABLE_MEMORY_TAGS,
  ADMIN_PREFERENCE_MEMORY_TAGS,
  mapPostgresAdminPrivacySummary,
} from './admin.js';

/**
 * Subject-authorized admin aggregation/filter queries (a27w.5).
 *
 * These replace the subject-authorized proxy's previous strategy of paging the
 * entire authorized corpus into process (`listAllAuthorized`) and computing
 * admin filters, privacy summaries, stats, and channel/contact slices in JS.
 * Every query here appends `buildMemorySubjectAuthorizationPredicate` in the
 * same statement, so:
 *   - authorization is applied IN the aggregation (a summary/count/slice can
 *     never observe a memory the caller is not authorized for), and
 *   - work is bounded (SQL COUNT/GROUP BY and LIMIT'd slices, never an
 *     unbounded row scan feeding JS).
 *
 * Equivalence contract: these queries reproduce the exact semantics of the old
 * in-process JS path (subject-authorized-store.ts). In particular the
 * preference predicate is tags-only (NOT the operator raw store's
 * text-regex-inclusive `preferenceAdminMemoryCondition`), and the retention
 * class filter is exact equality — matching the proxy's `isPreference` and
 * `filterAdminMemories`. The JS reference lives in
 * `test-support/in-memory-memory-subjects.ts` and is asserted equal in the
 * integration equivalence test.
 */

type PgNumeric = number | string;

interface StatsRow {
  type: string;
  count: PgNumeric;
  salience_sum: PgNumeric | null;
}

type AdminPageTotals = {
  authorized_total: PgNumeric | null;
  all_total: PgNumeric | null;
};
type EmptyAdminPageRow = { [Key in keyof MemoryRow]: null } & AdminPageTotals;
type AdminPageRow = (MemoryRow & AdminPageTotals) | EmptyAdminPageRow;

function hasAdminPage(row: AdminPageRow): row is MemoryRow & AdminPageTotals {
  return row.id !== null;
}

/**
 * Excludes internal cognitive artifacts (context-feedback) exactly like
 * `isInternalMemoryArtifact`: a `source:context_feedback|` source-ref prefix or
 * a `context_feedback` tag (case-insensitive).
 */
const INTERNAL_ARTIFACT_EXCLUSION_SQL = `
  NOT (
    lower(memory.source_ref) LIKE 'source:context_feedback|%'
    OR (
      jsonb_typeof(memory.tags) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(memory.tags) AS tag(value)
        WHERE lower(tag.value) = 'context_feedback'
      )
    )
  )
`;

const ACTIVE_CLAUSES = ['memory.superseded_by IS NULL', 'memory.deleted_at IS NULL'] as const;

function pushValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

/**
 * Tags-only preference predicate matching the subject proxy's `isPreference`:
 * a non-boundary memory carrying an admin preference tag or a `preference:*`
 * namespaced tag. Deliberately excludes free-text heuristics.
 */
function subjectPreferenceSql(values: unknown[]): string {
  const tagsParam = pushValue(values, [...ADMIN_PREFERENCE_MEMORY_TAGS]);
  return `(
    memory.type <> 'boundary'
    AND jsonb_typeof(memory.tags) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(memory.tags) AS tag(value)
      WHERE lower(tag.value) = ANY(${tagsParam}::text[])
        OR lower(tag.value) LIKE 'preference:%'
    )
  )`;
}

/**
 * Durable predicate matching the subject proxy's `isDurable`: durable retention
 * class or an admin durable tag.
 */
function subjectDurableSql(values: unknown[]): string {
  const tagsParam = pushValue(values, [...ADMIN_DURABLE_MEMORY_TAGS]);
  return `(
    memory.retention_class = 'durable'
    OR (
      jsonb_typeof(memory.tags) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(memory.tags) AS tag(value)
        WHERE lower(tag.value) = ANY(${tagsParam}::text[])
      )
    )
  )`;
}

function appendAuthorizationPredicate(
  input: MemorySubjectAdminQuery,
  filterValues: unknown[],
  filterClauses: string[],
): { where: string; values: unknown[] } {
  const predicate = buildMemorySubjectAuthorizationPredicate(input.authorization, {
    memoryAlias: 'memory',
    firstParameter: filterValues.length + 1,
  });
  const values = [...filterValues, ...predicate.values];
  const where = [...ACTIVE_CLAUSES, ...filterClauses, predicate.sql].join('\n  AND ');
  return { where, values };
}

function assertAdminActionMatchesSelector(input: MemorySubjectAdminQuery): void {
  const allowed = (() => {
    switch (input.selector.kind) {
      case 'admin_page':
      case 'channel_prefix':
      case 'contact_filter':
        return ['list'] as const;
      case 'privacy_summary':
      case 'admin_stats':
      case 'stats':
        return ['count'] as const;
    }
  })();
  if (!(allowed as readonly string[]).includes(input.authorization.action)) {
    throw new Error(
      `Memory subject admin action ${input.authorization.action} does not permit ${input.selector.kind}`,
    );
  }
}

async function queryAdminPage(
  pool: Pool,
  input: MemorySubjectAdminQuery,
  options: MemoryAdminListOptions,
): Promise<MemorySubjectAdminResult> {
  const filterValues: unknown[] = [];
  const filterClauses: string[] = [];
  if (options.type !== undefined) {
    filterClauses.push(`memory.type = ${pushValue(filterValues, options.type)}`);
  }
  if (options.sensitivity !== undefined) {
    filterClauses.push(`memory.sensitivity = ${pushValue(filterValues, options.sensitivity)}`);
  }
  if (options.retentionClass !== undefined) {
    // Exact equality mirrors the proxy's `memory.retentionClass === options.retentionClass`.
    filterClauses.push(`memory.retention_class = ${pushValue(filterValues, options.retentionClass)}`);
  }
  if (options.preferenceOnly === true) {
    filterClauses.push(subjectPreferenceSql(filterValues));
  }
  if (options.startDate !== undefined) {
    filterClauses.push(`memory.extracted_at >= ${pushValue(filterValues, options.startDate)}`);
  }
  if (options.endDate !== undefined) {
    filterClauses.push(`memory.extracted_at <= ${pushValue(filterValues, options.endDate)}`);
  }
  filterClauses.push(INTERNAL_ARTIFACT_EXCLUSION_SQL);
  const { where, values } = appendAuthorizationPredicate(input, filterValues, filterClauses);
  const allWhere = [...ACTIVE_CLAUSES, ...filterClauses].join('\n  AND ');
  const limit = clampLimit(options.limit, 50, 1, 500);
  const offset = clampLimit(options.offset, 0, 0, 100_000);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  const rows = await pool.query<AdminPageRow>(
    `
    WITH all_matching AS MATERIALIZED (
      SELECT memory.id
      FROM l2_memories memory
      WHERE ${allWhere}
    ),
    authorized AS MATERIALIZED (
      SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
      FROM l2_memories memory
      WHERE ${where}
    )
    SELECT page.*, totals.authorized_total, totals.all_total
    FROM (
      SELECT
        (SELECT COUNT(*) FROM authorized) AS authorized_total,
        (SELECT COUNT(*) FROM all_matching) AS all_total
    ) totals
    LEFT JOIN LATERAL (
      SELECT * FROM authorized
      ORDER BY extracted_at DESC, id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    ) page ON TRUE
  `,
    [...values, limit, offset],
  );
  const total = Number(rows.rows.at(0)?.authorized_total ?? 0);
  const allTotal = Number(rows.rows.at(0)?.all_total ?? 0);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(allTotal) || allTotal < total) {
    throw new Error('Memory subject admin coverage counts are inconsistent');
  }
  const memories = rows.rows
    .filter(hasAdminPage)
    .map(row => ({ ...fromMemoryRow(row), similarity: 1 }));
  return {
    kind: 'memories',
    memories,
    total,
    withheldBySubjectAuthorizationCount: allTotal - total,
  };
}

async function querySourcePrefixSlice(
  pool: Pool,
  input: MemorySubjectAdminQuery,
  clause: string,
  filterValues: unknown[],
  limit: number,
): Promise<MemorySubjectAdminResult> {
  const { where, values } = appendAuthorizationPredicate(input, filterValues, [clause]);
  const safeLimit = clampLimit(limit, 50, 1, 500);
  const rows = await pool.query<MemoryRow>(
    `
    SELECT ${MEMORY_SUBJECT_SELECT_COLUMNS}
    FROM l2_memories memory
    WHERE ${where}
    ORDER BY memory.extracted_at DESC, memory.id DESC
    LIMIT $${values.length + 1}
  `,
    [...values, safeLimit],
  );
  const memories = rows.rows.map(row => ({ ...fromMemoryRow(row), similarity: 1 }));
  return { kind: 'memories', memories, total: memories.length };
}

async function queryChannelPrefix(
  pool: Pool,
  input: MemorySubjectAdminQuery,
  channelId: string,
  limit: number,
): Promise<MemorySubjectAdminResult> {
  // Matches `memory.sourceRef.startsWith(`${channelId}:`)` exactly; starts_with
  // avoids LIKE metacharacter escaping.
  const filterValues: unknown[] = [];
  const prefixParam = pushValue(filterValues, `${channelId}:`);
  return await querySourcePrefixSlice(
    pool,
    input,
    `starts_with(memory.source_ref, ${prefixParam})`,
    filterValues,
    limit,
  );
}

async function queryContactFilter(
  pool: Pool,
  input: MemorySubjectAdminQuery,
  contactId: string,
  limit: number,
): Promise<MemorySubjectAdminResult> {
  const filterValues: unknown[] = [];
  const contactParam = pushValue(filterValues, contactId);
  return await querySourcePrefixSlice(
    pool,
    input,
    `memory.contact_id = ${contactParam}`,
    filterValues,
    limit,
  );
}

async function queryPrivacySummary(
  pool: Pool,
  input: MemorySubjectAdminQuery,
): Promise<MemorySubjectAdminResult> {
  // The aggregate query carries the preference/durable tag-array params; the
  // sensitivity grouping does not, so each gets its own parameter list (reusing
  // one would bind params the other statement never references — Postgres cannot
  // infer their type).
  const aggFilterValues: unknown[] = [];
  const preferenceSql = subjectPreferenceSql(aggFilterValues);
  const durableSql = subjectDurableSql(aggFilterValues);
  const aggregatePlan = appendAuthorizationPredicate(input, aggFilterValues, [
    INTERNAL_ARTIFACT_EXCLUSION_SQL,
  ]);
  const aggregate = await pool.query<AdminMemoryPrivacyAggregateRow>(
    `
    SELECT
      COUNT(*) AS active_memory_count,
      COALESCE(SUM(CASE WHEN memory.sensitivity IN ('intimate', 'confidential') THEN 1 ELSE 0 END), 0) AS high_sensitivity_count,
      COALESCE(SUM(CASE WHEN memory.consent_flags->>'allowRecall' = 'false' THEN 1 ELSE 0 END), 0) AS consent_gated_count,
      COALESCE(SUM(CASE WHEN memory.contact_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS contact_linked_count,
      COALESCE(SUM(CASE
        WHEN (memory.scope_ref_kind IS NOT NULL AND memory.scope_ref_id IS NOT NULL)
          OR (jsonb_typeof(memory.scope_tags) = 'array' AND jsonb_array_length(memory.scope_tags) > 0)
        THEN 1 ELSE 0 END), 0) AS scoped_count,
      COALESCE(SUM(CASE WHEN ${preferenceSql} THEN 1 ELSE 0 END), 0) AS preference_count,
      COALESCE(SUM(CASE WHEN ${preferenceSql} AND ${durableSql} THEN 1 ELSE 0 END), 0) AS durable_preference_count
    FROM l2_memories memory
    WHERE ${aggregatePlan.where}
  `,
    aggregatePlan.values,
  );
  const sensitivityPlan = appendAuthorizationPredicate(input, [], [INTERNAL_ARTIFACT_EXCLUSION_SQL]);
  const sensitivity = await pool.query<SensitivityCountRow>(
    `
    SELECT memory.sensitivity AS sensitivity, COUNT(*) AS count
    FROM l2_memories memory
    WHERE ${sensitivityPlan.where}
    GROUP BY memory.sensitivity
  `,
    sensitivityPlan.values,
  );
  return {
    kind: 'privacy_summary',
    privacySummary: mapPostgresAdminPrivacySummary(aggregate.rows[0], sensitivity.rows),
  };
}

async function queryStats(
  pool: Pool,
  input: MemorySubjectAdminQuery,
  excludeInternalArtifacts = false,
): Promise<MemorySubjectAdminResult> {
  // Ordinary `stats` mirrors the proxy `getStats` over the full active
  // authorized corpus. Garden `admin_stats` opts into the same internal-artifact
  // exclusion as `admin_page` without changing that broader contract.
  const { where, values } = appendAuthorizationPredicate(
    input,
    [],
    excludeInternalArtifacts ? [INTERNAL_ARTIFACT_EXCLUSION_SQL] : [],
  );
  const rows = await pool.query<StatsRow>(
    `
    SELECT memory.type AS type, COUNT(*) AS count, COALESCE(SUM(memory.salience), 0) AS salience_sum
    FROM l2_memories memory
    WHERE ${where}
    GROUP BY memory.type
  `,
    values,
  );
  const byType: Record<string, number> = {};
  let total = 0;
  let salienceSum = 0;
  for (const row of rows.rows) {
    const count = parsePgNumber(row.count, 'count');
    byType[row.type] = count;
    total += count;
    salienceSum += parsePgNumber(row.salience_sum ?? 0, 'salience_sum');
  }
  return {
    kind: 'stats',
    stats: { total, byType, avgSalience: total > 0 ? salienceSum / total : 0 },
  };
}

/**
 * Compute a subject-authorized admin aggregate/filter entirely in Postgres. The
 * caller (the subject-authorized proxy) supplies an already-derived
 * authorization; this function never widens it. A query failure propagates
 * (fail closed) — there is no fallback to raw/unauthorized aggregation.
 */
export async function queryAuthorizedMemorySubjectAdmin(
  pool: Pool,
  input: MemorySubjectAdminQuery,
): Promise<MemorySubjectAdminResult> {
  assertAdminActionMatchesSelector(input);
  switch (input.selector.kind) {
    case 'admin_page':
      return await queryAdminPage(pool, input, input.selector.options ?? {});
    case 'channel_prefix':
      return await queryChannelPrefix(pool, input, input.selector.channelId, input.selector.limit);
    case 'contact_filter':
      return await queryContactFilter(pool, input, input.selector.contactId, input.selector.limit);
    case 'privacy_summary':
      return await queryPrivacySummary(pool, input);
    case 'admin_stats':
      return await queryStats(pool, input, true);
    case 'stats':
      return await queryStats(pool, input);
  }
}
