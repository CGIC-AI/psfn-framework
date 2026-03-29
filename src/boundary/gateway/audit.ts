// ── Persistent audit log ──
// Every gateway RPC call is logged to SQLite for review.

import Database from 'better-sqlite3';
import type { PolicyDecision } from './protocol.js';

export interface AuditEntry {
  id: number;
  timestamp: number;
  method: string;
  decision: PolicyDecision;
  paramsJson: string;
  durationMs: number | null;
  error: string | null;
}

export interface AuditRotationConfig {
  maxSizeBytes: number;
  maxAgeMs: number;
  maxCount: number;
}

export interface AuditSummaryEntry {
  method: string;
  decision: PolicyDecision;
  params?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
}

export type AuditSummaryHook = (entry: AuditSummaryEntry) => void;

export interface GatewayAuditStorePort {
  log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number;
  complete(id: number, durationMs: number, error?: string): void;
  recordSummary(entry: AuditSummaryEntry): number;
  createSummaryHook(): AuditSummaryHook;
  getRecent(limit?: number): AuditEntry[];
  getByMethod(method: string, limit?: number): AuditEntry[];
  getApprovalEvents(limit?: number): AuditEntry[];
  count(): number;
}

const DEFAULT_ROTATION_CONFIG: AuditRotationConfig = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 50_000,
};

const SIZE_PRUNE_BATCH = 100;

export class AuditStore implements GatewayAuditStorePort {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly updateDurationStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly pruneByAgeStmt: Database.Statement;
  private readonly pruneByCountStmt: Database.Statement;
  private readonly estimateSizeStmt: Database.Statement;
  private readonly pruneOldestBatchStmt: Database.Statement;
  private readonly rotation: AuditRotationConfig;

  constructor(db: Database.Database, rotationConfig?: Partial<AuditRotationConfig>) {
    this.db = db;
    this.rotation = resolveRotationConfig(rotationConfig);
    this.createTable();
    this.insertStmt = this.db.prepare(`
      INSERT INTO gateway_audit (timestamp, method, decision, params_json, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.updateDurationStmt = this.db.prepare(`
      UPDATE gateway_audit SET duration_ms = ?, error = ? WHERE id = ?
    `);
    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM gateway_audit
    `);
    this.pruneByAgeStmt = this.db.prepare(`
      DELETE FROM gateway_audit WHERE timestamp < ?
    `);
    this.pruneByCountStmt = this.db.prepare(`
      DELETE FROM gateway_audit
      WHERE id IN (
        SELECT id FROM gateway_audit
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    this.estimateSizeStmt = this.db.prepare(`
      SELECT COALESCE(SUM(
        LENGTH(method) +
        LENGTH(decision) +
        COALESCE(LENGTH(params_json), 0) +
        COALESCE(LENGTH(error), 0) +
        24
      ), 0) AS bytes
      FROM gateway_audit
    `);
    this.pruneOldestBatchStmt = this.db.prepare(`
      DELETE FROM gateway_audit
      WHERE id IN (
        SELECT id FROM gateway_audit
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      )
    `);
  }

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        method TEXT NOT NULL,
        decision TEXT NOT NULL,
        params_json TEXT,
        duration_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON gateway_audit(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_method ON gateway_audit(method);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON gateway_audit(decision);
    `);
  }

  log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number {
    const timestamp = Date.now();
    const paramsJson = params ? summarizeParams(params) : null;
    const result = this.insertStmt.run(timestamp, method, decision, paramsJson, null, null);
    this.enforceRotation(timestamp);
    return Number(result.lastInsertRowid);
  }

  complete(id: number, durationMs: number, error?: string): void {
    this.updateDurationStmt.run(durationMs, error ?? null, id);
  }

  recordSummary(entry: AuditSummaryEntry): number {
    const id = this.log(entry.method, entry.decision, entry.params);
    this.complete(id, normalizeDurationMs(entry.durationMs), entry.error);
    return id;
  }

  createSummaryHook(): AuditSummaryHook {
    return (entry) => {
      this.recordSummary(entry);
    };
  }

  private static readonly SELECT_COLS = `
    id, timestamp, method, decision,
    params_json AS paramsJson,
    duration_ms AS durationMs,
    error`;

  getRecent(limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as AuditEntry[];
  }

  getByMethod(method: string, limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      WHERE method = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(method, limit) as AuditEntry[];
  }

  getApprovalEvents(limit: number = 50): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      WHERE decision != 'ALLOW'
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as AuditEntry[];
  }

  count(): number {
    const row = this.countStmt.get() as { cnt: number };
    return row.cnt;
  }

  private enforceRotation(nowMs: number): void {
    this.pruneByAgeStmt.run(nowMs - this.rotation.maxAgeMs);
    this.pruneByCountStmt.run(this.rotation.maxCount);
    this.pruneBySize();
  }

  private pruneBySize(): void {
    let currentSize = this.getApproximatePayloadSizeBytes();
    while (currentSize > this.rotation.maxSizeBytes) {
      const removableRows = this.count() - 1;
      if (removableRows <= 0) {
        break;
      }
      const batchSize = Math.min(SIZE_PRUNE_BATCH, removableRows);
      const result = this.pruneOldestBatchStmt.run(batchSize) as { changes: number };
      if (result.changes === 0) {
        break;
      }
      currentSize = this.getApproximatePayloadSizeBytes();
    }
  }

  private getApproximatePayloadSizeBytes(): number {
    const row = this.estimateSizeStmt.get() as { bytes: number };
    return row.bytes;
  }
}

// Summarize params for logging — redact content fields that could be large
function summarizeParams(params: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'content' && typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + `... (${value.length} chars)`;
    } else if (key === 'messages' && Array.isArray(value)) {
      summary[key] = `[${value.length} messages]`;
    } else if (key === 'systemPrompt' && typeof value === 'string') {
      summary[key] = `(${value.length} chars)`;
    } else if (key === 'texts' && Array.isArray(value)) {
      summary[key] = `[${value.length} texts]`;
    } else if (key === 'syncEnvelope' && isRecord(value)) {
      summary[key] = summarizeSyncEnvelope(value);
    } else if (key === 'syncDecision' && isRecord(value)) {
      summary[key] = summarizeSyncDecision(value);
    } else {
      summary[key] = value;
    }
  }
  return JSON.stringify(summary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeSyncEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const summarized: Record<string, unknown> = {};
  for (const key of [
    'version',
    'syncClass',
    'direction',
    'authority',
    'operation',
    'shardId',
    'sourceId',
    'targetId',
    'requestedAt',
  ]) {
    const value = envelope[key];
    if (value !== undefined) {
      summarized[key] = value;
    }
  }

  const idempotency = envelope.idempotencyKey;
  if (typeof idempotency === 'string') {
    summarized.idempotencyKey = idempotency.length > 96
      ? `${idempotency.slice(0, 96)}... (${idempotency.length} chars)`
      : idempotency;
  }
  return summarized;
}

function summarizeSyncDecision(decision: Record<string, unknown>): Record<string, unknown> {
  const summarized: Record<string, unknown> = {};
  for (const key of ['allowed', 'reason']) {
    const value = decision[key];
    if (value !== undefined) {
      summarized[key] = value;
    }
  }
  return summarized;
}

function resolveRotationConfig(overrides?: Partial<AuditRotationConfig>): AuditRotationConfig {
  const resolved = { ...DEFAULT_ROTATION_CONFIG, ...overrides };
  return {
    maxSizeBytes: positiveInteger('maxSizeBytes', resolved.maxSizeBytes),
    maxAgeMs: positiveInteger('maxAgeMs', resolved.maxAgeMs),
    maxCount: positiveInteger('maxCount', resolved.maxCount),
  };
}

function normalizeDurationMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return value;
}
