import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema, executeQuery, queryOne, queryRows } from '../../persistence/postgres.js';
import { POSTGRES_AUDIT_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import type {
  AuditEntry,
  AuditRotationConfig,
  AuditSummaryEntry,
  AuditSummaryHook,
  GatewayAuditStorePort,
} from './audit.js';
import type { PolicyDecision } from './protocol.js';

const DEFAULT_ROTATION_CONFIG: AuditRotationConfig = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCount: 50_000,
};

const SIZE_PRUNE_BATCH = 100;

export interface PostgresGatewayAuditStoreOptions {
  pool?: Pool;
  applicationName?: string;
  now?: () => number;
}

interface AuditRow {
  id: number | string;
  timestamp: number | string;
  method: string;
  decision: PolicyDecision;
  paramsJson: string | null;
  durationMs: number | string | null;
  error: string | null;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return value;
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

function summarizeParams(params: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'content' && typeof value === 'string' && value.length > 200) {
      summary[key] = `${value.slice(0, 200)}... (${value.length} chars)`;
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

function mapAuditRow(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    timestamp: Number(row.timestamp),
    method: row.method,
    decision: row.decision,
    paramsJson: row.paramsJson ?? '',
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    error: row.error,
  };
}

class PostgresGatewayAuditStore implements GatewayAuditStorePort {
  private readonly rotation: AuditRotationConfig;

  constructor(
    private readonly pool: Pool,
    rotationConfig?: Partial<AuditRotationConfig>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.rotation = resolveRotationConfig(rotationConfig);
  }

  async log(method: string, decision: PolicyDecision, params?: Record<string, unknown>): Promise<number> {
    const timestamp = this.now();
    const paramsJson = params ? summarizeParams(params) : null;
    const row = await queryOne<Pick<AuditRow, 'id'>>(
      this.pool,
      `
        INSERT INTO gateway_audit (timestamp, method, decision, params_json, duration_ms, error)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [timestamp, method, decision, paramsJson, null, null],
    );
    if (!row) {
      throw new Error('Failed to insert audit entry');
    }
    await this.enforceRotation(timestamp);
    return Number(row.id);
  }

  async complete(id: number, durationMs: number, error?: string): Promise<void> {
    await executeQuery(
      this.pool,
      `
        UPDATE gateway_audit
        SET duration_ms = $1, error = $2
        WHERE id = $3
      `,
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

  async getRecent(limit = 50): Promise<AuditEntry[]> {
    const rows = await queryRows<AuditRow>(
      this.pool,
      `
        SELECT id, timestamp, method, decision, params_json AS "paramsJson", duration_ms AS "durationMs", error
        FROM gateway_audit
        ORDER BY timestamp DESC, id DESC
        LIMIT $1
      `,
      [limit],
    );
    return rows.map(mapAuditRow);
  }

  async getByMethod(method: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await queryRows<AuditRow>(
      this.pool,
      `
        SELECT id, timestamp, method, decision, params_json AS "paramsJson", duration_ms AS "durationMs", error
        FROM gateway_audit
        WHERE method = $1
        ORDER BY timestamp DESC, id DESC
        LIMIT $2
      `,
      [method, limit],
    );
    return rows.map(mapAuditRow);
  }

  async getApprovalEvents(limit = 50): Promise<AuditEntry[]> {
    const rows = await queryRows<AuditRow>(
      this.pool,
      `
        SELECT id, timestamp, method, decision, params_json AS "paramsJson", duration_ms AS "durationMs", error
        FROM gateway_audit
        WHERE decision != 'ALLOW'
        ORDER BY timestamp DESC, id DESC
        LIMIT $1
      `,
      [limit],
    );
    return rows.map(mapAuditRow);
  }

  async count(): Promise<number> {
    const row = await queryOne<{ cnt: number | string }>(
      this.pool,
      `SELECT COUNT(*)::INTEGER AS cnt FROM gateway_audit`,
    );
    return row ? Number(row.cnt) : 0;
  }

  private async enforceRotation(nowMs: number): Promise<void> {
    await executeQuery(
      this.pool,
      `DELETE FROM gateway_audit WHERE timestamp < $1`,
      [nowMs - this.rotation.maxAgeMs],
    );
    await executeQuery(
      this.pool,
      `
        DELETE FROM gateway_audit
        WHERE id IN (
          SELECT id
          FROM gateway_audit
          ORDER BY timestamp DESC, id DESC
          OFFSET $1
        )
      `,
      [this.rotation.maxCount],
    );
    await this.pruneBySize();
  }

  private async pruneBySize(): Promise<void> {
    let currentSize = await this.getApproximatePayloadSizeBytes();
    while (currentSize > this.rotation.maxSizeBytes) {
      const removableRows = (await this.countRows()) - 1;
      if (removableRows <= 0) {
        break;
      }
      const batchSize = Math.min(SIZE_PRUNE_BATCH, removableRows);
      const result = await executeQuery(
        this.pool,
        `
          DELETE FROM gateway_audit
          WHERE id IN (
            SELECT id
            FROM gateway_audit
            ORDER BY timestamp ASC, id ASC
            LIMIT $1
          )
        `,
        [batchSize],
      );
      if (result.rowCount === 0) {
        break;
      }
      currentSize = await this.getApproximatePayloadSizeBytes();
    }
  }

  private async getApproximatePayloadSizeBytes(): Promise<number> {
    const row = await queryOne<{ bytes: number | string }>(
      this.pool,
      `
        SELECT COALESCE(SUM(
          LENGTH(method) +
          LENGTH(decision) +
          COALESCE(LENGTH(params_json), 0) +
          COALESCE(LENGTH(error), 0) +
          24
        ), 0)::BIGINT AS bytes
        FROM gateway_audit
      `,
    );
    return row ? Number(row.bytes) : 0;
  }

  private async countRows(): Promise<number> {
    const row = await queryOne<{ cnt: number | string }>(
      this.pool,
      `SELECT COUNT(*)::INTEGER AS cnt FROM gateway_audit`,
    );
    return row ? Number(row.cnt) : 0;
  }
}

export function createPostgresGatewayAuditStoreFromPool(
  pool: Pool,
  rotationConfig?: Partial<AuditRotationConfig>,
  now?: () => number,
): GatewayAuditStorePort {
  return new PostgresGatewayAuditStore(pool, rotationConfig, now);
}

export async function createPostgresGatewayAuditStore(
  databaseUrl: string,
  rotationConfig?: Partial<AuditRotationConfig>,
  options: PostgresGatewayAuditStoreOptions = {},
): Promise<GatewayAuditStorePort> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-gateway-audit',
    allowExitOnIdle: true,
  });
  await ensurePostgresSchema(pool, POSTGRES_AUDIT_MIGRATIONS);
  return createPostgresGatewayAuditStoreFromPool(pool, rotationConfig, options.now);
}
