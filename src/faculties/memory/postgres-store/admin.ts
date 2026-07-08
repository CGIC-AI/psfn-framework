import type {
  MemoryAdminListOptions,
  MemoryAdminPrivacySummary,
} from '../memory-store-port.js';
import {
  CORE_DURABLE_MEMORY_TAGS,
  DURABLE_PREFERENCE_MEMORY_TAG,
  DURABLE_RETENTION_TAG,
  PREFERENCE_MEMORY_TAG,
} from '../types.js';
import {
  type AdminMemoryPrivacyAggregateRow,
  type SensitivityCountRow,
  parsePgNumber,
} from './rows.js';

export const ADMIN_DURABLE_MEMORY_TAGS = [
  DURABLE_RETENTION_TAG,
  DURABLE_PREFERENCE_MEMORY_TAG,
  ...CORE_DURABLE_MEMORY_TAGS,
] as const;
export const ADMIN_PREFERENCE_MEMORY_TAGS = [
  PREFERENCE_MEMORY_TAG,
  DURABLE_PREFERENCE_MEMORY_TAG,
  'favorite',
  'favourite',
  'like',
  'likes',
  'liked',
  'love',
  'loves',
  'loved',
  'enjoy',
  'enjoys',
  'preferred',
  'prefers',
  'dislike',
  'dislikes',
  'hates',
  'stable_preference',
] as const;
export const ADMIN_FAVORITE_TEXT_REGEX =
  String.raw`(^|[^[:alnum:]_])((my|our|his|her|their|[[:alpha:]][[:alnum:]_-]*'s)[[:space:]]+favou?rite|favou?rite[[:space:]]+[[:alnum:]_-]+[[:space:]]+(is|are|was|were))([^[:alnum:]_]|$)`;
export const ADMIN_PREFERENCE_TEXT_REGEX =
  String.raw`(^|[^[:alnum:]_])((i|we)[[:space:]]+(really[[:space:]]+)?(prefer|preferred|like|liked|love|loved|enjoy|enjoyed|hate|hated|dislike|disliked|don't[[:space:]]+like|do[[:space:]]+not[[:space:]]+like|can't[[:space:]]+stand|cannot[[:space:]]+stand)|(prefers|preferred|likes|liked|loves|loved|enjoys|enjoyed|hates|hated|dislikes|disliked))([^[:alnum:]_]|$)`;

export function activeAdminMemoryClause(): string {
  return `
    superseded_by IS NULL
    AND deleted_at IS NULL
    AND NOT (
      lower(source_ref) LIKE 'source:context_feedback|%'
      OR (
        jsonb_typeof(tags) = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(tags) AS tag(value)
          WHERE lower(tag.value) = 'context_feedback'
        )
      )
    )
  `;
}

export function durableAdminMemoryCondition(tagParam: string): string {
  return `
    (
      retention_class = 'durable'
      OR (
        jsonb_typeof(tags) = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(tags) AS tag(value)
          WHERE lower(tag.value) = ANY(${tagParam}::text[])
        )
      )
    )
  `;
}

export function preferenceAdminMemoryCondition(
  tagParam: string,
  favoriteRegexParam: string,
  preferenceRegexParam: string,
): string {
  return `
    (
      type <> 'boundary'
      AND (
        (
          jsonb_typeof(tags) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(tags) AS tag(value)
            WHERE lower(tag.value) = ANY(${tagParam}::text[])
              OR lower(tag.value) LIKE 'preference:%'
          )
        )
        OR text ~* ${favoriteRegexParam}
        OR text ~* ${preferenceRegexParam}
      )
    )
  `;
}

export function addPostgresQueryValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

export function buildPostgresAdminMemoryWhere(options: MemoryAdminListOptions = {}): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const clauses = [activeAdminMemoryClause()];
  if (options.type) {
    clauses.push(`type = ${addPostgresQueryValue(values, options.type)}`);
  }
  if (options.sensitivity) {
    clauses.push(`sensitivity = ${addPostgresQueryValue(values, options.sensitivity)}`);
  }
  if (options.retentionClass === 'durable') {
    clauses.push(durableAdminMemoryCondition(addPostgresQueryValue(values, [...ADMIN_DURABLE_MEMORY_TAGS])));
  } else if (options.retentionClass === 'standard') {
    clauses.push(`NOT ${durableAdminMemoryCondition(addPostgresQueryValue(values, [...ADMIN_DURABLE_MEMORY_TAGS]))}`);
  }
  if (options.preferenceOnly) {
    clauses.push(preferenceAdminMemoryCondition(
      addPostgresQueryValue(values, [...ADMIN_PREFERENCE_MEMORY_TAGS]),
      addPostgresQueryValue(values, ADMIN_FAVORITE_TEXT_REGEX),
      addPostgresQueryValue(values, ADMIN_PREFERENCE_TEXT_REGEX),
    ));
  }
  if (options.startDate !== undefined) {
    clauses.push(`extracted_at >= ${addPostgresQueryValue(values, options.startDate)}`);
  }
  if (options.endDate !== undefined) {
    clauses.push(`extracted_at <= ${addPostgresQueryValue(values, options.endDate)}`);
  }
  return {
    sql: clauses.map(clause => `(${clause})`).join(' AND '),
    values,
  };
}

export function mapPostgresAdminPrivacySummary(
  row: AdminMemoryPrivacyAggregateRow | undefined,
  sensitivityRows: SensitivityCountRow[],
): MemoryAdminPrivacySummary {
  const sensitivityCounts: Record<string, number> = {};
  for (const sensitivityRow of sensitivityRows) {
    sensitivityCounts[sensitivityRow.sensitivity ?? 'personal'] = parsePgNumber(sensitivityRow.count, 'count');
  }
  return {
    activeMemoryCount: row ? parsePgNumber(row.active_memory_count, 'active_memory_count') : 0,
    highSensitivityCount: row ? parsePgNumber(row.high_sensitivity_count, 'high_sensitivity_count') : 0,
    consentGatedCount: row ? parsePgNumber(row.consent_gated_count, 'consent_gated_count') : 0,
    contactLinkedCount: row ? parsePgNumber(row.contact_linked_count, 'contact_linked_count') : 0,
    scopedCount: row ? parsePgNumber(row.scoped_count, 'scoped_count') : 0,
    preferenceCount: row ? parsePgNumber(row.preference_count, 'preference_count') : 0,
    durablePreferenceCount: row ? parsePgNumber(row.durable_preference_count, 'durable_preference_count') : 0,
    sensitivityCounts,
  };
}
