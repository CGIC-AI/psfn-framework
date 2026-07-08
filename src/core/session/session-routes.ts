import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const SESSION_ROUTE_STATE_VERSION = 1 as const;

export type SessionRouteResetMode = 'fresh_split' | 'break_glass_quarantine';

export const SESSION_QUARANTINE_EXCLUDED_CONTEXT_CLASSES = [
  'recent_entries',
  'compaction_summaries',
  'focus_knowledge',
  'focus_compaction_ranges',
  'wake_return_artifacts',
  'core_memory_scope',
  'orientation_summaries',
  'active_memory_cache',
  'cross_channel_continuity',
  'session_mirrors',
  'l2_memory_retrieval',
  'episodic_landmarks',
  'contact_profile_summaries',
] as const;

export interface RetiredSessionRoute {
  logicalSessionId: string;
  sourceChannelId: string;
  retiredAt: string;
  routeGeneration: number;
  mode: SessionRouteResetMode;
  actor: string;
  reason: string;
  excludedContextClasses: string[];
}

export interface SourceChannelSessionRoute {
  sourceChannelId: string;
  activeLogicalSessionId: string;
  createdAt: string;
  updatedAt: string;
  routeGeneration: number;
  mode: SessionRouteResetMode;
  actor: string;
  reason: string;
  retiredSessions: RetiredSessionRoute[];
}

export interface SessionRouteState {
  version: typeof SESSION_ROUTE_STATE_VERSION;
  updatedAt: string;
  routes: Record<string, SourceChannelSessionRoute>;
}

export interface SessionRouteResetInput {
  sourceChannelId: string;
  actor?: string;
  reason: string;
  mode?: SessionRouteResetMode;
}

export interface SessionRouteResetResult {
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  route: SourceChannelSessionRoute;
  retiredSession: RetiredSessionRoute;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseRouteResetMode(value: unknown, field: string): SessionRouteResetMode {
  if (value === 'fresh_split' || value === 'break_glass_quarantine') return value;
  throw new Error(`${field} must be fresh_split or break_glass_quarantine`);
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((item, index) => normalizeRequiredString(item, `${field}[${index}]`));
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field} contains unknown field "${key}"`);
    }
  }
}

const RETIRED_SESSION_KEYS = new Set([
  'logicalSessionId',
  'sourceChannelId',
  'retiredAt',
  'routeGeneration',
  'mode',
  'actor',
  'reason',
  'excludedContextClasses',
]);

function parseRetiredSessionRoute(value: unknown, field: string): RetiredSessionRoute {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  assertKnownKeys(value, RETIRED_SESSION_KEYS, field);
  return {
    logicalSessionId: normalizeRequiredString(value.logicalSessionId, `${field}.logicalSessionId`),
    sourceChannelId: normalizeRequiredString(value.sourceChannelId, `${field}.sourceChannelId`),
    retiredAt: normalizeRequiredString(value.retiredAt, `${field}.retiredAt`),
    routeGeneration: parsePositiveInteger(value.routeGeneration, `${field}.routeGeneration`),
    mode: parseRouteResetMode(value.mode, `${field}.mode`),
    actor: normalizeRequiredString(value.actor, `${field}.actor`),
    reason: normalizeRequiredString(value.reason, `${field}.reason`),
    excludedContextClasses: parseStringArray(
      value.excludedContextClasses,
      `${field}.excludedContextClasses`,
    ),
  };
}

const SOURCE_ROUTE_KEYS = new Set([
  'sourceChannelId',
  'activeLogicalSessionId',
  'createdAt',
  'updatedAt',
  'routeGeneration',
  'mode',
  'actor',
  'reason',
  'retiredSessions',
]);

function parseSourceRoute(value: unknown, key: string): SourceChannelSessionRoute {
  if (!isRecord(value)) {
    throw new Error(`session route "${key}" must be an object`);
  }
  assertKnownKeys(value, SOURCE_ROUTE_KEYS, `session route "${key}"`);
  const sourceChannelId = normalizeRequiredString(value.sourceChannelId, `session route "${key}".sourceChannelId`);
  if (sourceChannelId !== key) {
    throw new Error(`session route key mismatch: expected "${key}", found "${sourceChannelId}"`);
  }
  const retiredRaw = value.retiredSessions;
  if (!Array.isArray(retiredRaw)) {
    throw new Error(`session route "${key}".retiredSessions must be an array`);
  }
  return {
    sourceChannelId,
    activeLogicalSessionId: normalizeRequiredString(
      value.activeLogicalSessionId,
      `session route "${key}".activeLogicalSessionId`,
    ),
    createdAt: normalizeRequiredString(value.createdAt, `session route "${key}".createdAt`),
    updatedAt: normalizeRequiredString(value.updatedAt, `session route "${key}".updatedAt`),
    routeGeneration: parsePositiveInteger(value.routeGeneration, `session route "${key}".routeGeneration`),
    mode: parseRouteResetMode(value.mode, `session route "${key}".mode`),
    actor: normalizeRequiredString(value.actor, `session route "${key}".actor`),
    reason: normalizeRequiredString(value.reason, `session route "${key}".reason`),
    retiredSessions: retiredRaw.map((item, index) => parseRetiredSessionRoute(
      item,
      `session route "${key}".retiredSessions[${index}]`,
    )),
  };
}

function parseSessionRouteState(value: unknown): SessionRouteState {
  if (!isRecord(value)) {
    throw new Error('session route state must be an object');
  }
  assertKnownKeys(value, new Set(['version', 'updatedAt', 'routes']), 'session route state');
  if (value.version !== SESSION_ROUTE_STATE_VERSION) {
    throw new Error(`unsupported session route state version: ${String(value.version)}`);
  }
  if (!isRecord(value.routes)) {
    throw new Error('session route state routes must be an object');
  }
  const routes: Record<string, SourceChannelSessionRoute> = {};
  for (const [key, route] of Object.entries(value.routes)) {
    routes[key] = parseSourceRoute(route, key);
  }
  return {
    version: SESSION_ROUTE_STATE_VERSION,
    updatedAt: normalizeRequiredString(value.updatedAt, 'session route state.updatedAt'),
    routes,
  };
}

function cloneRetiredSession(route: RetiredSessionRoute): RetiredSessionRoute {
  return {
    ...route,
    excludedContextClasses: [...route.excludedContextClasses],
  };
}

function cloneSourceRoute(route: SourceChannelSessionRoute): SourceChannelSessionRoute {
  return {
    ...route,
    retiredSessions: route.retiredSessions.map(cloneRetiredSession),
  };
}

function createEmptyState(now: Date): SessionRouteState {
  return {
    version: SESSION_ROUTE_STATE_VERSION,
    updatedAt: now.toISOString(),
    routes: {},
  };
}

function createLogicalSessionId(sourceChannelId: string, now: Date): string {
  const compactTime = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${sourceChannelId}:session:${compactTime}-${randomUUID().slice(0, 8)}`;
}

export class SessionRouteStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private state: SessionRouteState;

  constructor(filePath: string, options: { now?: () => Date } = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.state = this.load();
  }

  private findRoute(sourceChannelId: string): SourceChannelSessionRoute | undefined {
    const normalized = sourceChannelId.trim();
    return Object.prototype.hasOwnProperty.call(this.state.routes, normalized)
      ? this.state.routes[normalized]
      : undefined;
  }

  resolve(sourceChannelId: string): string | null {
    return this.findRoute(sourceChannelId)?.activeLogicalSessionId ?? null;
  }

  resolveSourceChannelId(channelId: string): string {
    const normalized = channelId.trim();
    for (const route of Object.values(this.state.routes)) {
      if (route.activeLogicalSessionId === normalized) return route.sourceChannelId;
      if (route.retiredSessions.some(retired => retired.logicalSessionId === normalized)) {
        return route.sourceChannelId;
      }
    }
    return normalized;
  }

  getRoute(sourceChannelId: string): SourceChannelSessionRoute | null {
    const route = this.findRoute(sourceChannelId);
    return route ? cloneSourceRoute(route) : null;
  }

  getRouteForLogicalSession(logicalSessionId: string): SourceChannelSessionRoute | null {
    const normalized = logicalSessionId.trim();
    for (const route of Object.values(this.state.routes)) {
      if (
        route.activeLogicalSessionId === normalized
        || route.retiredSessions.some(retired => retired.logicalSessionId === normalized)
      ) {
        return cloneSourceRoute(route);
      }
    }
    return null;
  }

  listRoutes(): SourceChannelSessionRoute[] {
    return Object.values(this.state.routes)
      .map(cloneSourceRoute)
      .sort((left, right) => left.sourceChannelId.localeCompare(right.sourceChannelId));
  }

  isRetiredOrQuarantined(logicalSessionId: string): boolean {
    const normalized = logicalSessionId.trim();
    if (!normalized) return false;
    return Object.values(this.state.routes)
      .some(route => route.retiredSessions.some(retired => retired.logicalSessionId === normalized));
  }

  getRetiredLogicalSessionIds(): Set<string> {
    return new Set(Object.values(this.state.routes).flatMap(route => (
      route.retiredSessions.map(retired => retired.logicalSessionId)
    )));
  }

  resetSourceChannel(input: SessionRouteResetInput): SessionRouteResetResult {
    const sourceChannelId = normalizeRequiredString(input.sourceChannelId, 'sourceChannelId');
    const reason = normalizeRequiredString(input.reason, 'reason');
    const actor = normalizeOptionalString(input.actor) ?? 'operator';
    const mode = input.mode ?? 'break_glass_quarantine';
    const now = this.now();
    const timestamp = now.toISOString();
    const existing = this.findRoute(sourceChannelId);
    const oldLogicalSessionId = existing?.activeLogicalSessionId ?? sourceChannelId;
    const routeGeneration = (existing?.routeGeneration ?? 0) + 1;
    const newLogicalSessionId = createLogicalSessionId(sourceChannelId, now);
    const retiredSession: RetiredSessionRoute = {
      logicalSessionId: oldLogicalSessionId,
      sourceChannelId,
      retiredAt: timestamp,
      routeGeneration,
      mode,
      actor,
      reason,
      excludedContextClasses: [...SESSION_QUARANTINE_EXCLUDED_CONTEXT_CLASSES],
    };
    const previousRetired = existing?.retiredSessions ?? [];
    const nextRetired = previousRetired.some(retired => retired.logicalSessionId === oldLogicalSessionId)
      ? previousRetired.map(retired => (
        retired.logicalSessionId === oldLogicalSessionId ? retiredSession : retired
      ))
      : [...previousRetired, retiredSession];
    const route: SourceChannelSessionRoute = {
      sourceChannelId,
      activeLogicalSessionId: newLogicalSessionId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      routeGeneration,
      mode,
      actor,
      reason,
      retiredSessions: nextRetired.map(cloneRetiredSession),
    };
    this.state = {
      version: SESSION_ROUTE_STATE_VERSION,
      updatedAt: timestamp,
      routes: {
        ...this.state.routes,
        [sourceChannelId]: route,
      },
    };
    this.persist();
    return {
      sourceChannelId,
      oldLogicalSessionId,
      newLogicalSessionId,
      route: cloneSourceRoute(route),
      retiredSession: cloneRetiredSession(retiredSession),
    };
  }

  private load(): SessionRouteState {
    if (!existsSync(this.filePath)) {
      return createEmptyState(this.now());
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    return parseSessionRouteState(JSON.parse(raw) as unknown);
  }

  private persist(): void {
    writeJsonAtomic(this.filePath, this.state);
  }
}
