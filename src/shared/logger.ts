// ── Structured Logger ──
// Winston-based logger with configurable levels via LOG_LEVEL env var.
// Usage: import { logger } from './logger.js';
//        logger.info('message', { key: 'value' });

import { createLogger, format, transports } from 'winston';
import { sanitizeDiagnosticText, sanitizeDiagnosticValue } from './diagnostics/redaction.js';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const DIAGNOSTIC_LOG_RING_LIMIT = 256;
const DIAGNOSTIC_LOG_CONTEXT_KEYS = new Set([
  'attempt',
  'backupDir',
  'code',
  'copiedSessionFiles',
  'delayMs',
  'encrypted',
  'error',
  'maxRetries',
  'mirrored',
  'model',
  'phase',
  'postgresDumpCaptured',
  'provider',
  'reason',
  'restoreVerified',
  'sqliteCaptured',
  'taskId',
  'taskName',
  'toolName',
]);

export interface DiagnosticLogRecord {
  observedAt: number;
  level: 'warn' | 'error';
  message: string;
  component?: string;
  context?: Record<string, string | number | boolean | null>;
  source: string;
}

const diagnosticLogRing: DiagnosticLogRecord[] = [];

function buildDiagnosticLogContext(
  meta: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  const context: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!DIAGNOSTIC_LOG_CONTEXT_KEYS.has(key)) continue;
    context[key] = sanitizeDiagnosticValue(value, key);
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function captureDiagnosticLogRecord(info: Record<string, unknown>): void {
  const level = typeof info.level === 'string' ? info.level.toLowerCase() : '';
  if (level !== 'warn' && level !== 'error') return;

  const { level: _level, message, component, timestamp: _timestamp, ...meta } = info;
  const record: DiagnosticLogRecord = {
    observedAt: Date.now(),
    level,
    message: sanitizeDiagnosticText(message),
    source: 'in_process',
  };
  if (typeof component === 'string' && component.trim()) {
    record.component = sanitizeDiagnosticText(component);
  }
  const context = buildDiagnosticLogContext(meta);
  if (context) record.context = context;

  diagnosticLogRing.push(record);
  if (diagnosticLogRing.length > DIAGNOSTIC_LOG_RING_LIMIT) {
    diagnosticLogRing.splice(0, diagnosticLogRing.length - DIAGNOSTIC_LOG_RING_LIMIT);
  }
}

const diagnosticCaptureFormat = format((info) => {
  captureDiagnosticLogRecord(info as Record<string, unknown>);
  return info;
});

export const logger = createLogger({
  level: LOG_LEVEL,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4,
  },
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    diagnosticCaptureFormat(),
    format.printf(({ timestamp, level, message, component, ...meta }) => {
      const tag = component ? `[${component}]` : '';
      const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} ${level.toUpperCase().padEnd(5)} ${tag} ${message}${extra}`;
    }),
  ),
  transports: [
    new transports.Console(),
  ],
});

/** Create a child logger with a fixed component tag */
export function createComponentLogger(component: string) {
  return logger.child({ component });
}

export function getRecentDiagnosticLogRecords(options: {
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
} = {}): DiagnosticLogRecord[] {
  const sinceMs = Number.isFinite(options.sinceMs) ? Math.max(0, options.sinceMs!) : 0;
  const untilMs = Number.isFinite(options.untilMs) ? Math.max(0, options.untilMs!) : Number.POSITIVE_INFINITY;
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(DIAGNOSTIC_LOG_RING_LIMIT, Math.floor(options.limit!)))
    : DIAGNOSTIC_LOG_RING_LIMIT;
  return diagnosticLogRing
    .filter(record => record.observedAt >= sinceMs && record.observedAt <= untilMs)
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, limit)
    .map(record => ({
      ...record,
      ...(record.context ? { context: { ...record.context } } : {}),
    }));
}

export function clearDiagnosticLogRingBufferForTests(): void {
  diagnosticLogRing.splice(0);
}

export function recordDiagnosticLogRecordForTests(input: {
  level: 'warn' | 'error';
  message: string;
  component?: string;
  observedAt?: number;
}): void {
  const record: DiagnosticLogRecord = {
    observedAt: input.observedAt ?? Date.now(),
    level: input.level,
    message: sanitizeDiagnosticText(input.message),
    source: 'in_process',
  };
  if (input.component) record.component = sanitizeDiagnosticText(input.component);
  diagnosticLogRing.push(record);
  if (diagnosticLogRing.length > DIAGNOSTIC_LOG_RING_LIMIT) {
    diagnosticLogRing.splice(0, diagnosticLogRing.length - DIAGNOSTIC_LOG_RING_LIMIT);
  }
}
