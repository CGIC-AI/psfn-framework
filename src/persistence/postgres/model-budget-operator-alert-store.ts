import type { Pool, PoolClient } from 'pg';
import type { ModelBudgetAlertDeliveryEvent } from '../../shared/contracts/runtime.js';
import {
  modelBudgetOperatorAlertDedupeKey,
  type ModelBudgetOperatorAlertClaim,
  type ModelBudgetOperatorAlertIdentity,
  type ModelBudgetOperatorAlertStorePort,
} from '../../shared/contracts/model-budget-alert.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

interface AlertAuthorityRow {
  companionId: string;
}

interface AlertEvidenceSummaryRow {
  attemptCount: number | string;
  delivered: boolean;
}

interface AlertEvidenceRow {
  recordedAtMs: number | string;
  dedupeKey: string;
  thresholdReason: ModelBudgetAlertDeliveryEvent['thresholdReason'];
  windowKey: string;
  status: ModelBudgetAlertDeliveryEvent['status'];
  topic: string | null;
  messageId: string | null;
  error: string | null;
}

function validateWindowKey(
  reason: ModelBudgetOperatorAlertIdentity['thresholdReason'],
  value: string,
): string {
  const normalized = value.trim();
  const dateText = reason === 'daily_budget_exceeded'
    ? `${normalized}T00:00:00.000Z`
    : `${normalized}-01T00:00:00.000Z`;
  const expectedLength = reason === 'daily_budget_exceeded' ? 10 : 7;
  const parsed = new Date(dateText);
  if (
    normalized.length !== expectedLength
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, expectedLength) !== normalized
  ) {
    throw new Error(`Invalid ${reason} model-budget alert window key`);
  }
  return normalized;
}

function validateIdentity(identity: ModelBudgetOperatorAlertIdentity): ModelBudgetOperatorAlertIdentity {
  const thresholdReason: unknown = identity.thresholdReason;
  if (
    thresholdReason !== 'daily_budget_exceeded'
    && thresholdReason !== 'monthly_budget_exceeded'
  ) {
    throw new Error('Unsupported model-budget operator-alert threshold reason');
  }
  return {
    companionId: createCompanionId(identity.companionId, 'model-budget operator-alert companionId'),
    thresholdReason,
    windowKey: validateWindowKey(thresholdReason, identity.windowKey),
  };
}

function validateDeliveryEvent(
  identity: ModelBudgetOperatorAlertIdentity,
  event: ModelBudgetAlertDeliveryEvent,
): void {
  if (!Number.isSafeInteger(event.timestampMs) || event.timestampMs < 0) {
    throw new Error('Model-budget operator-alert delivery timestamp must be non-negative');
  }
  if (
    event.thresholdReason !== identity.thresholdReason
    || event.windowKey !== identity.windowKey
    || event.dedupeKey !== modelBudgetOperatorAlertDedupeKey(identity)
  ) {
    throw new Error('Model-budget operator-alert delivery evidence does not match its claim');
  }
  const status: unknown = event.status;
  if (status !== 'sent' && status !== 'debounced' && status !== 'failed') {
    throw new Error('Unsupported model-budget operator-alert delivery status');
  }
  if (event.status === 'failed' && !event.error?.trim()) {
    throw new Error('Failed model-budget operator-alert evidence requires an error');
  }
}

class PostgresModelBudgetOperatorAlertClaim implements ModelBudgetOperatorAlertClaim {
  private finished = false;

  constructor(
    private readonly client: PoolClient,
    private readonly identity: ModelBudgetOperatorAlertIdentity,
    readonly attempt: number,
  ) {}

  async recordDelivery(event: ModelBudgetAlertDeliveryEvent): Promise<void> {
    if (this.finished) throw new Error('Model-budget operator-alert claim is already settled');
    try {
      validateDeliveryEvent(this.identity, event);
      await this.client.query(
        `
          INSERT INTO model_budget_operator_alert_delivery_events (
            companion_id, threshold_reason, window_key, attempt, recorded_at_ms,
            dedupe_key, status, topic, message_id, error
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          this.identity.companionId,
          this.identity.thresholdReason,
          this.identity.windowKey,
          this.attempt,
          event.timestampMs,
          event.dedupeKey,
          event.status,
          event.topic ?? null,
          event.messageId ?? null,
          event.error ?? null,
        ],
      );
      await this.client.query('COMMIT');
      this.finished = true;
      this.client.release();
    } catch (error) {
      await this.rollbackAndThrow(error);
    }
  }

  async release(): Promise<void> {
    if (this.finished) return;
    try {
      await this.client.query('ROLLBACK');
    } finally {
      this.finished = true;
      this.client.release();
    }
  }

  private async rollbackAndThrow(error: unknown): Promise<never> {
    let rollbackError: unknown;
    try {
      await this.client.query('ROLLBACK');
    } catch (caught) {
      rollbackError = caught;
    } finally {
      this.finished = true;
      this.client.release();
    }
    if (rollbackError !== undefined) {
      throw new AggregateError(
        [error, rollbackError],
        'Model-budget operator-alert evidence write and rollback both failed',
      );
    }
    throw error;
  }
}

export class PostgresModelBudgetOperatorAlertStore implements ModelBudgetOperatorAlertStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly waitUntilReady: () => Promise<void>,
  ) {}

  async claimModelBudgetOperatorAlert(
    input: ModelBudgetOperatorAlertIdentity,
  ): Promise<ModelBudgetOperatorAlertClaim | null> {
    await this.waitUntilReady();
    const identity = validateIdentity(input);
    const createdAtMs = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO model_budget_operator_alerts (
            companion_id, threshold_reason, window_key, created_at_ms
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (companion_id, threshold_reason, window_key) DO NOTHING
        `,
        [identity.companionId, identity.thresholdReason, identity.windowKey, createdAtMs],
      );
      const locked = await client.query<AlertAuthorityRow>(
        `
          SELECT companion_id AS "companionId"
          FROM model_budget_operator_alerts
          WHERE companion_id = $1
            AND threshold_reason = $2
            AND window_key = $3
          FOR UPDATE
        `,
        [identity.companionId, identity.thresholdReason, identity.windowKey],
      );
      const row = locked.rows[0];
      if (!row) throw new Error('Model-budget operator-alert durable identity disappeared');
      const evidence = await client.query<AlertEvidenceSummaryRow>(
        `
          SELECT
            COALESCE(MAX(attempt), 0) AS "attemptCount",
            COALESCE(BOOL_OR(status IN ('sent', 'debounced')), FALSE) AS delivered
          FROM model_budget_operator_alert_delivery_events
          WHERE companion_id = $1
            AND threshold_reason = $2
            AND window_key = $3
        `,
        [identity.companionId, identity.thresholdReason, identity.windowKey],
      );
      const summary = evidence.rows[0];
      if (!summary) throw new Error('Model-budget operator-alert evidence summary is unavailable');
      if (summary.delivered) {
        await client.query('ROLLBACK');
        client.release();
        return null;
      }
      const attempt = Number(summary.attemptCount) + 1;
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error('Model-budget operator-alert attempt counter is invalid');
      }
      return new PostgresModelBudgetOperatorAlertClaim(client, identity, attempt);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      throw error;
    }
  }

  async listModelBudgetOperatorAlertEvidence(
    input: ModelBudgetOperatorAlertIdentity,
  ): Promise<ModelBudgetAlertDeliveryEvent[]> {
    await this.waitUntilReady();
    const identity = validateIdentity(input);
    const rows = await this.pool.query<AlertEvidenceRow>(
      `
        SELECT
          recorded_at_ms AS "recordedAtMs",
          dedupe_key AS "dedupeKey",
          threshold_reason AS "thresholdReason",
          window_key AS "windowKey",
          status,
          topic,
          message_id AS "messageId",
          error
        FROM model_budget_operator_alert_delivery_events
        WHERE companion_id = $1
          AND threshold_reason = $2
          AND window_key = $3
        ORDER BY attempt ASC
      `,
      [identity.companionId, identity.thresholdReason, identity.windowKey],
    );
    return rows.rows.map(row => ({
      timestampMs: Number(row.recordedAtMs),
      dedupeKey: row.dedupeKey,
      thresholdReason: row.thresholdReason,
      windowKey: row.windowKey,
      status: row.status,
      ...(row.topic ? { topic: row.topic } : {}),
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.error ? { error: row.error } : {}),
    }));
  }
}
