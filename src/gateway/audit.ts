// ── Persistent audit log ──
// Every gateway RPC call is logged to SQLite for review.

import type { DatabaseAdapter } from '../persistence/db-adapter.js';
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

const DEFAULT_ROTATION_CONFIG: AuditRotationConfig = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 50_000,
};

const SIZE_PRUNE_BATCH = 100;

export class AuditStore {
  private readonly adapter: DatabaseAdapter;
  private readonly rotation: AuditRotationConfig;

  constructor(adapter: DatabaseAdapter, rotationConfig?: Partial<AuditRotationConfig>) {
    this.adapter = adapter;
    this.rotation = resolveRotationConfig(rotationConfig);
  }

  async init(): Promise<void> {
    await this.createTable();
  }

  private async createTable(): Promise<void> {
    await this.adapter.exec(`
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

  async log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): Promise<number> {
    const timestamp = Date.now();
    const paramsJson = params ? summarizeParams(params) : null;
    const result = await this.adapter.run(
      `INSERT INTO gateway_audit (timestamp, method, decision, params_json, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [timestamp, method, decision, paramsJson, null, null],
    );
    await this.enforceRotation(timestamp);
    return Number(result.lastInsertRowid);
  }

  async complete(id: number, durationMs: number, error?: string): Promise<void> {
    await this.adapter.run(
      `UPDATE gateway_audit SET duration_ms = ?, error = ? WHERE id = ?`,
      [durationMs, error ?? null, id],
    );
  }

  async recordSummary(entry: AuditSummaryEntry): Promise<number> {
    const id = await this.log(entry.method, entry.decision, entry.params);
    await this.complete(id, normalizeDurationMs(entry.durationMs), entry.error);
    return id;
  }

  createSummaryHook(): AuditSummaryHook {
    return async (entry) => {
      await this.recordSummary(entry);
    };
  }

  private static readonly SELECT_COLS = `
    id, timestamp, method, decision,
    params_json AS paramsJson,
    duration_ms AS durationMs,
    error`;

  async getRecent(limit: number = 50): Promise<AuditEntry[]> {
    return this.adapter.query<AuditEntry>(
      `SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
      [limit],
    );
  }

  async getByMethod(method: string, limit: number = 50): Promise<AuditEntry[]> {
    return this.adapter.query<AuditEntry>(
      `SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      WHERE method = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
      [method, limit],
    );
  }

  async getApprovalEvents(limit: number = 50): Promise<AuditEntry[]> {
    return this.adapter.query<AuditEntry>(
      `SELECT ${AuditStore.SELECT_COLS}
      FROM gateway_audit
      WHERE decision != 'ALLOW'
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
      [limit],
    );
  }

  async count(): Promise<number> {
    const row = await this.adapter.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM gateway_audit`,
    );
    return row?.cnt ?? 0;
  }

  private async enforceRotation(nowMs: number): Promise<void> {
    await this.adapter.run(
      `DELETE FROM gateway_audit WHERE timestamp < ?`,
      [nowMs - this.rotation.maxAgeMs],
    );
    await this.adapter.run(
      `DELETE FROM gateway_audit
      WHERE id IN (
        SELECT id FROM gateway_audit
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )`,
      [this.rotation.maxCount],
    );
    await this.pruneBySize();
  }

  private async pruneBySize(): Promise<void> {
    let currentSize = await this.getApproximatePayloadSizeBytes();
    while (currentSize > this.rotation.maxSizeBytes) {
      const removableRows = await this.count() - 1;
      if (removableRows <= 0) {
        break;
      }
      const batchSize = Math.min(SIZE_PRUNE_BATCH, removableRows);
      const result = await this.adapter.run(
        `DELETE FROM gateway_audit
        WHERE id IN (
          SELECT id FROM gateway_audit
          ORDER BY timestamp ASC, id ASC
          LIMIT ?
        )`,
        [batchSize],
      );
      if (result.changes === 0) {
        break;
      }
      currentSize = await this.getApproximatePayloadSizeBytes();
    }
  }

  private async getApproximatePayloadSizeBytes(): Promise<number> {
    const row = await this.adapter.queryOne<{ bytes: number }>(
      `SELECT COALESCE(SUM(
        LENGTH(method) +
        LENGTH(decision) +
        COALESCE(LENGTH(params_json), 0) +
        COALESCE(LENGTH(error), 0) +
        24
      ), 0) AS bytes
      FROM gateway_audit`,
    );
    return row?.bytes ?? 0;
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
