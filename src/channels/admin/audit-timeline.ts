import type {
  AdminAuditActionType,
  AdminAuditDecision,
  AdminAuditTimeRange,
  AdminAuditTimelineEntry,
  AdminAuditTimelineFilters,
} from './types.js';

const MAX_AUDIT_TIMELINE_ENTRIES = 500;

export const ADMIN_AUDIT_ACTION_TYPES: AdminAuditActionType[] = [
  'tool_invocation',
  'identity_edit',
  'external_action',
  'memory_mutation',
];

export const ADMIN_AUDIT_DECISIONS: AdminAuditDecision[] = [
  'allowed',
  'denied',
];

export const ADMIN_AUDIT_TIME_RANGES: AdminAuditTimeRange[] = [
  '15m',
  '1h',
  '24h',
  '7d',
  '30d',
  'all',
];

const TIME_RANGE_MS: Record<Exclude<AdminAuditTimeRange, 'all'>, number> = {
  '15m': 15 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
};

function isAuditActionType(value: string): value is AdminAuditActionType {
  return ADMIN_AUDIT_ACTION_TYPES.includes(value as AdminAuditActionType);
}

function isAuditDecision(value: string): value is AdminAuditDecision {
  return ADMIN_AUDIT_DECISIONS.includes(value as AdminAuditDecision);
}

function isAuditTimeRange(value: string): value is AdminAuditTimeRange {
  return ADMIN_AUDIT_TIME_RANGES.includes(value as AdminAuditTimeRange);
}

export class AdminAuditTimelineStore {
  private entries: AdminAuditTimelineEntry[] = [];
  private counter = 0;

  append(entry: Omit<AdminAuditTimelineEntry, 'id' | 'timestamp'> & { timestamp?: number }): AdminAuditTimelineEntry {
    const normalized: AdminAuditTimelineEntry = {
      id: `audit-${++this.counter}`,
      timestamp: entry.timestamp ?? Date.now(),
      actionType: entry.actionType,
      decision: entry.decision,
      narrative: entry.narrative,
      details: entry.details?.trim() || undefined,
    };
    this.entries.unshift(normalized);
    if (this.entries.length > MAX_AUDIT_TIMELINE_ENTRIES) {
      this.entries.length = MAX_AUDIT_TIMELINE_ENTRIES;
    }
    return normalized;
  }

  list(filters: AdminAuditTimelineFilters): AdminAuditTimelineEntry[] {
    const now = Date.now();
    const minTimestamp = filters.timeRange === 'all'
      ? 0
      : now - TIME_RANGE_MS[filters.timeRange];

    return this.entries.filter((entry) => {
      if (entry.timestamp < minTimestamp) return false;
      if (filters.actionType !== 'all' && entry.actionType !== filters.actionType) return false;
      if (filters.decision !== 'all' && entry.decision !== filters.decision) return false;
      return true;
    });
  }

  parseFilters(searchParams?: URLSearchParams): AdminAuditTimelineFilters {
    const rawActionType = (searchParams?.get('actionType') ?? 'all').trim();
    const rawDecision = (searchParams?.get('decision') ?? 'all').trim();
    const rawTimeRange = (searchParams?.get('timeRange') ?? '24h').trim();

    const actionType = rawActionType === 'all'
      ? 'all'
      : (isAuditActionType(rawActionType) ? rawActionType : 'all');
    const decision = rawDecision === 'all'
      ? 'all'
      : (isAuditDecision(rawDecision) ? rawDecision : 'all');
    const timeRange = isAuditTimeRange(rawTimeRange) ? rawTimeRange : '24h';

    return {
      actionType,
      decision,
      timeRange,
    };
  }
}
