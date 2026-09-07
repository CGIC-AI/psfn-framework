// ── Postgres CogSec admission receipt store (psfn-framework-1fjvm.3) ──
//
// Durable home for content-addressed screening receipts, so an admitted
// artifact stays admitted across a restart without re-paying L2/L3 cost, and
// so a receipt that no longer matches its bytes or contract simply is not
// found. The canonical receipt is the JSONB document; every read re-validates
// it through `validateCogSecReceipt`, which recomputes the self-binding digest
// — a row edited in the database is a load failure, not a quiet admission.

import type { Pool, QueryResultRow } from 'pg';

import {
  validateCogSecReceipt,
  type CogSecReceipt,
} from '../../shared/contracts/cogsec-receipt.js';
import type {
  CogSecReceiptLookupQuery,
  CogSecReceiptStorePort,
} from '../../core/cogsec/receipts/contracts.js';
import { createPostgresPool, ensurePostgresSchema, queryOne } from '../postgres.js';
import { POSTGRES_COGSEC_RECEIPT_MIGRATIONS } from './migrations.js';

interface ReceiptRow extends QueryResultRow {
  receipt_json: unknown;
  receipt_sha256: string;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

function assertDigest(value: string, field: string): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`CogSec receipt store ${field} must be 64 lowercase hex characters`);
  }
  return value;
}

export class PostgresCogSecReceiptStore implements CogSecReceiptStorePort {
  private constructor(private readonly pool: Pool, private readonly ownsPool: boolean) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresCogSecReceiptStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'cogsec-receipts',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_COGSEC_RECEIPT_MIGRATIONS);
    return new PostgresCogSecReceiptStore(pool, true);
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(pool: Pool): Promise<PostgresCogSecReceiptStore> {
    await ensurePostgresSchema(pool, POSTGRES_COGSEC_RECEIPT_MIGRATIONS);
    return new PostgresCogSecReceiptStore(pool, false);
  }

  /**
   * Record an issued receipt. Re-recording the identical receipt is a no-op;
   * a DIFFERENT receipt under an existing id is a hard failure rather than a
   * silent drop, because it means two distinct admissions collided on one
   * identity and one of them would otherwise vanish.
   */
  async record(receipt: CogSecReceipt): Promise<void> {
    const validated = validateCogSecReceipt(receipt);
    const inserted = await queryOne<ReceiptRow>(this.pool, `
      INSERT INTO cogsec_receipts (
        receipt_id, content_sha256, raw_content_sha256, screening_contract_digest,
        receipt_sha256, issuer_id, issuer_instance, envelope_id, verdict_action,
        issued_at_ms, expires_at_ms, receipt_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      ON CONFLICT (receipt_id) DO NOTHING
      RETURNING receipt_json, receipt_sha256
    `, [
      validated.receiptId,
      validated.contentSha256,
      validated.rawContentSha256,
      validated.screeningContractDigest,
      validated.receiptSha256,
      validated.issuer.id,
      validated.issuer.instance,
      validated.verdict.envelopeId,
      validated.verdict.action,
      validated.issuedAtMs,
      validated.expiresAtMs,
      JSON.stringify(validated),
    ]);
    if (inserted) return;
    const existing = await queryOne<ReceiptRow>(
      this.pool,
      'SELECT receipt_json, receipt_sha256 FROM cogsec_receipts WHERE receipt_id = $1',
      [validated.receiptId],
    );
    if (!existing || existing.receipt_sha256 !== validated.receiptSha256) {
      throw new Error(
        `CogSec receipt ${validated.receiptId} already exists with different contents`,
      );
    }
  }

  async findLatestForContent(query: CogSecReceiptLookupQuery): Promise<CogSecReceipt | null> {
    const row = await queryOne<ReceiptRow>(this.pool, `
      SELECT receipt_json, receipt_sha256
      FROM cogsec_receipts
      WHERE content_sha256 = $1 AND screening_contract_digest = $2
      ORDER BY issued_at_ms DESC, receipt_id DESC
      LIMIT 1
    `, [
      assertDigest(query.contentSha256, 'contentSha256'),
      assertDigest(query.screeningContractDigest, 'screeningContractDigest'),
    ]);
    return row ? validateCogSecReceipt(row.receipt_json) : null;
  }

  async getById(receiptId: string): Promise<CogSecReceipt | null> {
    if (receiptId.trim().length === 0) {
      throw new Error('CogSec receipt store getById requires a non-empty receipt id');
    }
    const row = await queryOne<ReceiptRow>(
      this.pool,
      'SELECT receipt_json, receipt_sha256 FROM cogsec_receipts WHERE receipt_id = $1',
      [receiptId],
    );
    return row ? validateCogSecReceipt(row.receipt_json) : null;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
