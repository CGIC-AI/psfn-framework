import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EventBus } from '../event-bus.js';
import {
  getRecentDiagnosticLogRecords,
  type DiagnosticLogRecord,
} from '../logger.js';
import { sanitizeDiagnosticText } from './redaction.js';

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_FILE_LOG_BYTES = 64 * 1024;
const MAX_FILE_LOG_FILES = 5;
const TOOL_VALIDATION_RING_LIMIT = 1024;
const LIFECYCLE_RING_LIMIT = 256;
const BACKUP_RING_LIMIT = 128;
const DEFAULT_FILE_LOG_DIR = '/app/logs';
const KUBE_UNAVAILABLE_REASON = 'requires kube surface (x5rt.4)';

export type DiagnosticSectionStatus = 'available' | 'unavailable' | 'error';

export interface RuntimeDiagnosticsQuery {
  sinceMs?: number;
  windowMs?: number;
  limit?: number;
  includeFileLogs?: boolean;
  logsDir?: string;
  now?: () => number;
}

export interface NormalizedRuntimeDiagnosticsQuery {
  sinceMs: number;
  untilMs: number;
  windowMs: number;
  limit: number;
  includeFileLogs: boolean;
  logsDir: string;
}

export interface DiagnosticUnavailable {
  status: 'unavailable';
  reason: string;
}

export interface DiagnosticError {
  status: 'error';
  reason: string;
}

export interface ToolValidationFailureDiagnostic {
  toolName: string;
  observedAt: number;
  reason: string;
}

export interface RuntimeLifecycleDiagnosticEvent {
  event: string;
  observedAt: number;
  component: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface BackupDiagnosticOutcome {
  status: 'success' | 'failure';
  observedAt: number;
  taskId?: string;
  taskName?: string;
  message: string;
  backupId?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface RuntimeDiagnosticsSnapshot {
  schemaVersion: 1;
  generatedAt: number;
  window: NormalizedRuntimeDiagnosticsQuery;
  sources: Array<{
    name: string;
    status: DiagnosticSectionStatus;
    reason?: string;
  }>;
  agentLog: {
    status: 'available';
    counts: { warn: number; error: number; total: number };
    records: DiagnosticLogRecord[];
  };
  fileLogs: {
    status: 'available';
    directory: string;
    filesScanned: number;
    counts: { warn: number; error: number; total: number };
    records: DiagnosticLogRecord[];
  } | DiagnosticUnavailable | DiagnosticError;
  toolValidationFailures: {
    status: 'available';
    total: number;
    byTool: Array<{
      toolName: string;
      count: number;
      firstSeenAt: number;
      lastSeenAt: number;
    }>;
  };
  lifecycle: {
    status: 'available';
    events: RuntimeLifecycleDiagnosticEvent[];
  };
  rollout: DiagnosticUnavailable;
  pods: DiagnosticUnavailable;
  backup: {
    status: 'available';
    counts: { success: number; failure: number; total: number };
    lastSuccess: BackupDiagnosticOutcome | null;
    lastFailure: BackupDiagnosticOutcome | null;
    recent: BackupDiagnosticOutcome[];
  };
}

const toolValidationFailures: ToolValidationFailureDiagnostic[] = [];
const lifecycleEvents: RuntimeLifecycleDiagnosticEvent[] = [];
const backupOutcomes: BackupDiagnosticOutcome[] = [];
const wiredEventBuses = new WeakSet<EventBus>();

function pushBounded<T>(ring: T[], value: T, limit: number): void {
  ring.push(value);
  if (ring.length > limit) {
    ring.splice(0, ring.length - limit);
  }
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sanitizeDetails(
  details: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> | undefined {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      sanitized[key] = sanitizeDiagnosticText(value);
    } else if (typeof value === 'number') {
      sanitized[key] = Number.isFinite(value) ? value : null;
    } else {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function normalizeRuntimeDiagnosticsQuery(input: RuntimeDiagnosticsQuery = {}): NormalizedRuntimeDiagnosticsQuery {
  const untilMs = Math.max(0, Math.floor(input.now?.() ?? Date.now()));
  const rawSinceMs = toFiniteNumber(input.sinceMs);
  const requestedWindowMs = rawSinceMs === null
    ? clampInteger(input.windowMs, DEFAULT_WINDOW_MS, MIN_WINDOW_MS, MAX_WINDOW_MS)
    : Math.max(MIN_WINDOW_MS, Math.min(MAX_WINDOW_MS, untilMs - Math.floor(rawSinceMs)));
  const sinceMs = Math.max(0, untilMs - requestedWindowMs);
  const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const logsDir = typeof input.logsDir === 'string' && input.logsDir.trim()
    ? input.logsDir.trim()
    : DEFAULT_FILE_LOG_DIR;

  return {
    sinceMs,
    untilMs,
    windowMs: untilMs - sinceMs,
    limit,
    includeFileLogs: input.includeFileLogs ?? true,
    logsDir,
  };
}

export function recordToolValidationFailure(input: {
  toolName: string;
  observedAt?: number;
  reason?: string;
}): void {
  const toolName = sanitizeDiagnosticText(input.toolName || 'unknown');
  pushBounded(toolValidationFailures, {
    toolName,
    observedAt: Math.max(0, Math.floor(input.observedAt ?? Date.now())),
    reason: sanitizeDiagnosticText(input.reason ?? 'Validation failed for tool arguments'),
  }, TOOL_VALIDATION_RING_LIMIT);
}

export function isToolValidationFailureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /^Validation failed for tool\s+"/.test(message);
}

export function recordLifecycleDiagnosticEvent(input: {
  event: string;
  component?: string;
  observedAt?: number;
  message: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}): void {
  const event: RuntimeLifecycleDiagnosticEvent = {
    event: sanitizeDiagnosticText(input.event || 'unknown'),
    observedAt: Math.max(0, Math.floor(input.observedAt ?? Date.now())),
    component: sanitizeDiagnosticText(input.component ?? 'runtime'),
    message: sanitizeDiagnosticText(input.message),
  };
  const details = input.details ? sanitizeDetails(input.details) : undefined;
  pushBounded(lifecycleEvents, details ? { ...event, details } : event, LIFECYCLE_RING_LIMIT);
}

export function recordBackupDiagnosticOutcome(input: {
  status: 'success' | 'failure';
  observedAt?: number;
  taskId?: string;
  taskName?: string;
  message: string;
  backupDir?: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}): void {
  const outcome: BackupDiagnosticOutcome = {
    status: input.status,
    observedAt: Math.max(0, Math.floor(input.observedAt ?? Date.now())),
    message: sanitizeDiagnosticText(input.message),
  };
  if (input.taskId) outcome.taskId = sanitizeDiagnosticText(input.taskId);
  if (input.taskName) outcome.taskName = sanitizeDiagnosticText(input.taskName);
  if (input.backupDir) outcome.backupId = sanitizeDiagnosticText(basename(input.backupDir));
  const details = input.details ? sanitizeDetails(input.details) : undefined;
  pushBounded(backupOutcomes, details ? { ...outcome, details } : outcome, BACKUP_RING_LIMIT);
}

export function wireRuntimeDiagnosticsEventCapture(eventBus: EventBus): void {
  if (wiredEventBuses.has(eventBus)) return;
  wiredEventBuses.add(eventBus);

  eventBus.on('system.init', () => {
    recordLifecycleDiagnosticEvent({
      event: 'system.init',
      component: 'system',
      message: 'System initialization started',
    });
  });
  eventBus.on('system.ready', () => {
    recordLifecycleDiagnosticEvent({
      event: 'system.ready',
      component: 'system',
      message: 'System ready',
    });
  });
  eventBus.on('system.shutdown', () => {
    recordLifecycleDiagnosticEvent({
      event: 'system.shutdown',
      component: 'system',
      message: 'System shutdown requested',
    });
  });
  eventBus.on('system.error', (event) => {
    recordLifecycleDiagnosticEvent({
      event: 'system.error',
      component: 'system',
      message: event.error.message,
      details: {
        context: event.context,
      },
    });
  });
  eventBus.on('module.install', (event) => {
    recordLifecycleDiagnosticEvent({
      event: 'module.install',
      component: 'module',
      message: `Module ${event.name} installed`,
      details: {
        id: event.id,
        version: event.version,
        source: event.source,
      },
    });
  });
  eventBus.on('module.uninstall', (event) => {
    recordLifecycleDiagnosticEvent({
      event: 'module.uninstall',
      component: 'module',
      message: `Module ${event.name} uninstalled`,
      details: {
        id: event.id,
        reason: event.reason,
      },
    });
  });
  eventBus.on('module.error', (event) => {
    recordLifecycleDiagnosticEvent({
      event: 'module.error',
      component: 'module',
      message: event.error,
      details: {
        id: event.id,
        name: event.name,
        stage: event.stage,
      },
    });
  });
  eventBus.on('backup.failed', (event) => {
    recordBackupDiagnosticOutcome({
      status: 'failure',
      observedAt: event.timestamp,
      taskId: event.taskId,
      taskName: event.taskName,
      message: event.error,
    });
  });
}

function byObservedAtDescending<T extends { observedAt: number }>(left: T, right: T): number {
  return right.observedAt - left.observedAt;
}

function withinWindow<T extends { observedAt: number }>(
  records: readonly T[],
  query: NormalizedRuntimeDiagnosticsQuery,
): T[] {
  return records
    .filter(record => record.observedAt >= query.sinceMs && record.observedAt <= query.untilMs)
    .sort(byObservedAtDescending);
}

function summarizeToolValidationFailures(query: NormalizedRuntimeDiagnosticsQuery): RuntimeDiagnosticsSnapshot['toolValidationFailures'] {
  const recent = withinWindow(toolValidationFailures, query);
  const byTool = new Map<string, { count: number; firstSeenAt: number; lastSeenAt: number }>();
  for (const event of recent) {
    const current = byTool.get(event.toolName);
    if (!current) {
      byTool.set(event.toolName, {
        count: 1,
        firstSeenAt: event.observedAt,
        lastSeenAt: event.observedAt,
      });
      continue;
    }
    current.count += 1;
    current.firstSeenAt = Math.min(current.firstSeenAt, event.observedAt);
    current.lastSeenAt = Math.max(current.lastSeenAt, event.observedAt);
  }

  return {
    status: 'available',
    total: recent.length,
    byTool: [...byTool.entries()]
      .map(([toolName, summary]) => ({ toolName, ...summary }))
      .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName))
      .slice(0, query.limit),
  };
}

function summarizeAgentLog(query: NormalizedRuntimeDiagnosticsQuery): RuntimeDiagnosticsSnapshot['agentLog'] {
  const records = getRecentDiagnosticLogRecords({
    sinceMs: query.sinceMs,
    untilMs: query.untilMs,
    limit: query.limit,
  });
  const warn = records.filter(record => record.level === 'warn').length;
  const error = records.filter(record => record.level === 'error').length;
  return {
    status: 'available',
    counts: { warn, error, total: records.length },
    records,
  };
}

function readFileTail(path: string): string {
  const stats = statSync(path);
  const length = Math.min(stats.size, MAX_FILE_LOG_BYTES);
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, stats.size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

function parseStructuredLogLine(
  line: string,
  fallbackObservedAt: number,
  fileName: string,
): DiagnosticLogRecord | null {
  try {
    const parsed = JSON.parse(line) as {
      level?: unknown;
      message?: unknown;
      component?: unknown;
      timestamp?: unknown;
      time?: unknown;
    };
    const rawLevel = typeof parsed.level === 'string' ? parsed.level.toLowerCase() : '';
    if (rawLevel !== 'warn' && rawLevel !== 'error') return null;
    const timestampValue = typeof parsed.timestamp === 'string'
      ? Date.parse(parsed.timestamp)
      : (typeof parsed.time === 'string' ? Date.parse(parsed.time) : NaN);
    return {
      observedAt: Number.isFinite(timestampValue) ? timestampValue : fallbackObservedAt,
      level: rawLevel,
      component: typeof parsed.component === 'string'
        ? sanitizeDiagnosticText(parsed.component)
        : 'file-log',
      message: sanitizeDiagnosticText(parsed.message ?? line),
      source: `file:${sanitizeDiagnosticText(fileName)}`,
    };
  } catch {
    return null;
  }
}

function parseTextLogLine(
  line: string,
  fallbackObservedAt: number,
  fileName: string,
): DiagnosticLogRecord | null {
  const match = /\b(ERROR|WARN(?:ING)?)\b/i.exec(line);
  if (!match) return null;
  const component = /\[([^\]]{1,64})\]/.exec(line)?.[1];
  return {
    observedAt: fallbackObservedAt,
    level: match[1].toLowerCase().startsWith('warn') ? 'warn' : 'error',
    ...(component ? { component: sanitizeDiagnosticText(component) } : {}),
    message: sanitizeDiagnosticText(line),
    source: `file:${sanitizeDiagnosticText(fileName)}`,
  };
}

function readFileLogDiagnostics(query: NormalizedRuntimeDiagnosticsQuery): RuntimeDiagnosticsSnapshot['fileLogs'] {
  if (!query.includeFileLogs) {
    return {
      status: 'unavailable',
      reason: 'file log diagnostics disabled for this request',
    };
  }
  if (!existsSync(query.logsDir)) {
    return {
      status: 'unavailable',
      reason: 'file log directory is not present',
    };
  }

  try {
    const files = readdirSync(query.logsDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map((entry) => {
        const path = join(query.logsDir, entry.name);
        const stats = statSync(path);
        return {
          name: entry.name,
          path,
          mtimeMs: stats.mtimeMs,
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, MAX_FILE_LOG_FILES);

    const records: DiagnosticLogRecord[] = [];
    for (const file of files) {
      const tail = readFileTail(file.path);
      for (const line of tail.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const structured = parseStructuredLogLine(trimmed, file.mtimeMs, file.name);
        const record = structured ?? parseTextLogLine(trimmed, file.mtimeMs, file.name);
        if (!record) continue;
        if (record.observedAt < query.sinceMs || record.observedAt > query.untilMs) continue;
        records.push(record);
      }
    }

    const selected = records
      .sort(byObservedAtDescending)
      .slice(0, query.limit);
    const warn = selected.filter(record => record.level === 'warn').length;
    const error = selected.filter(record => record.level === 'error').length;
    return {
      status: 'available',
      directory: query.logsDir,
      filesScanned: files.length,
      counts: { warn, error, total: selected.length },
      records: selected,
    };
  } catch (error) {
    return {
      status: 'error',
      reason: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
    };
  }
}

function summarizeBackup(query: NormalizedRuntimeDiagnosticsQuery): RuntimeDiagnosticsSnapshot['backup'] {
  const recent = withinWindow(backupOutcomes, query).slice(0, query.limit);
  const lastSuccess = recent.find(record => record.status === 'success') ?? null;
  const lastFailure = recent.find(record => record.status === 'failure') ?? null;
  const success = recent.filter(record => record.status === 'success').length;
  const failure = recent.filter(record => record.status === 'failure').length;
  return {
    status: 'available',
    counts: { success, failure, total: recent.length },
    lastSuccess,
    lastFailure,
    recent,
  };
}

export function buildRuntimeDiagnosticsSnapshot(input: RuntimeDiagnosticsQuery = {}): RuntimeDiagnosticsSnapshot {
  const query = normalizeRuntimeDiagnosticsQuery(input);
  const agentLog = summarizeAgentLog(query);
  const fileLogs = readFileLogDiagnostics(query);
  const sources: RuntimeDiagnosticsSnapshot['sources'] = [
    { name: 'in_process_logger', status: 'available' },
    {
      name: 'file_logs',
      status: fileLogs.status,
      ...(fileLogs.status === 'available' ? {} : { reason: fileLogs.reason }),
    },
    { name: 'tool_validation_telemetry', status: 'available' },
    { name: 'backup_runtime_state', status: 'available' },
    { name: 'kubernetes', status: 'unavailable', reason: KUBE_UNAVAILABLE_REASON },
  ];

  return {
    schemaVersion: 1,
    generatedAt: query.untilMs,
    window: query,
    sources,
    agentLog,
    fileLogs,
    toolValidationFailures: summarizeToolValidationFailures(query),
    lifecycle: {
      status: 'available',
      events: withinWindow(lifecycleEvents, query).slice(0, query.limit),
    },
    rollout: {
      status: 'unavailable',
      reason: KUBE_UNAVAILABLE_REASON,
    },
    pods: {
      status: 'unavailable',
      reason: KUBE_UNAVAILABLE_REASON,
    },
    backup: summarizeBackup(query),
  };
}

export function resetRuntimeDiagnosticsForTests(): void {
  toolValidationFailures.splice(0);
  lifecycleEvents.splice(0);
  backupOutcomes.splice(0);
}
