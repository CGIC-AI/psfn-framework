import type {
  AdminToolAvailabilityStatus,
  AdminToolHealthView,
  AdminToolInventoryGroup,
  RuntimeServiceHealthStatus,
} from '../../types/tools';

export const ALL_TOOL_FILTERS = 'all';

export interface ToolInventoryFilters {
  query: string;
  groupKey: string;
  scope: AdminToolHealthView['scope'] | typeof ALL_TOOL_FILTERS;
  healthStatus: RuntimeServiceHealthStatus | typeof ALL_TOOL_FILTERS;
  chatStatus: AdminToolAvailabilityStatus | typeof ALL_TOOL_FILTERS;
  heartbeatStatus: AdminToolAvailabilityStatus | typeof ALL_TOOL_FILTERS;
}

export interface ToolInventoryFilterOption {
  value: string;
  count: number;
  label?: string;
}

export interface ToolInventoryFilterOptions {
  groups: ToolInventoryFilterOption[];
  scopes: ToolInventoryFilterOption[];
  healthStatuses: ToolInventoryFilterOption[];
  chatStatuses: ToolInventoryFilterOption[];
  heartbeatStatuses: ToolInventoryFilterOption[];
}

const SCOPE_ORDER: readonly AdminToolHealthView['scope'][] = ['core', 'extended', 'conditional'];
const HEALTH_STATUS_ORDER: readonly RuntimeServiceHealthStatus[] = [
  'healthy',
  'degraded',
  'unavailable',
  'not_applicable',
];
const AVAILABILITY_STATUS_ORDER: readonly AdminToolAvailabilityStatus[] = [
  'active',
  'available',
  'unavailable',
  'not_applicable',
];

export function defaultToolInventoryFilters(): ToolInventoryFilters {
  return {
    query: '',
    groupKey: ALL_TOOL_FILTERS,
    scope: ALL_TOOL_FILTERS,
    healthStatus: ALL_TOOL_FILTERS,
    chatStatus: ALL_TOOL_FILTERS,
    heartbeatStatus: ALL_TOOL_FILTERS,
  };
}

export function countInventoryTools(groups: readonly AdminToolInventoryGroup[]): number {
  return groups.reduce((total, group) => total + group.tools.length, 0);
}

export function hasActiveToolInventoryFilters(filters: ToolInventoryFilters): boolean {
  return filters.query.trim().length > 0
    || filters.groupKey !== ALL_TOOL_FILTERS
    || filters.scope !== ALL_TOOL_FILTERS
    || filters.healthStatus !== ALL_TOOL_FILTERS
    || filters.chatStatus !== ALL_TOOL_FILTERS
    || filters.heartbeatStatus !== ALL_TOOL_FILTERS;
}

export function filterInventoryGroups(
  groups: readonly AdminToolInventoryGroup[],
  filters: ToolInventoryFilters,
): AdminToolInventoryGroup[] {
  const queryTerms = normalizeQueryTerms(filters.query);

  return groups.flatMap((group) => {
    if (!matchesSelectedFilter(group.key, filters.groupKey)) return [];

    const tools = group.tools.filter(tool => (
      matchesSelectedFilter(tool.scope, filters.scope)
      && matchesSelectedFilter(tool.health.status, filters.healthStatus)
      && matchesSelectedFilter(tool.contexts.chat.status, filters.chatStatus)
      && matchesSelectedFilter(tool.contexts.internalHeartbeat.status, filters.heartbeatStatus)
      && matchesSearchTerms(tool, queryTerms)
    ));

    return tools.length > 0
      ? [{ ...group, tools }]
      : [];
  });
}

export function deriveToolInventoryFilterOptions(
  groups: readonly AdminToolInventoryGroup[],
): ToolInventoryFilterOptions {
  const scopeCounts = new Map<string, number>();
  const healthCounts = new Map<string, number>();
  const chatCounts = new Map<string, number>();
  const heartbeatCounts = new Map<string, number>();

  for (const group of groups) {
    for (const tool of group.tools) {
      increment(scopeCounts, tool.scope);
      increment(healthCounts, tool.health.status);
      increment(chatCounts, tool.contexts.chat.status);
      increment(heartbeatCounts, tool.contexts.internalHeartbeat.status);
    }
  }

  return {
    groups: groups.map(group => ({
      value: group.key,
      label: group.title,
      count: group.tools.length,
    })),
    scopes: orderedOptions(SCOPE_ORDER, scopeCounts),
    healthStatuses: orderedOptions(HEALTH_STATUS_ORDER, healthCounts),
    chatStatuses: orderedOptions(AVAILABILITY_STATUS_ORDER, chatCounts),
    heartbeatStatuses: orderedOptions(AVAILABILITY_STATUS_ORDER, heartbeatCounts),
  };
}

function normalizeQueryTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesSearchTerms(tool: AdminToolHealthView, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  return terms.every(term => haystack.includes(term));
}

function matchesSelectedFilter(value: string, selected: string): boolean {
  return selected === ALL_TOOL_FILTERS || value === selected;
}

function increment(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function orderedOptions<T extends string>(
  preferredOrder: readonly T[],
  counts: ReadonlyMap<string, number>,
): ToolInventoryFilterOption[] {
  const preferred = preferredOrder
    .filter(value => counts.has(value))
    .map(value => ({ value, count: counts.get(value) ?? 0 }));
  const extra = Array.from(counts.entries())
    .filter(([value]) => !preferredOrder.includes(value as T))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
  return [...preferred, ...extra];
}
