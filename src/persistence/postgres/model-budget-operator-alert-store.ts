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
  dedupeKey: string;
  dispatchState: 'ready' | 'dispatching' | 'delivered';
  dispatchAttempt: number | string;
}

interface AdvisoryLockRow {
  acquired?: boolean;
  unlocked?: boolean;
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

function modelBudgetAlertAdvisoryKey(dedupeKey: string): string {
  return `model-budget-operator-alert:${dedupeKey}`;
}

async function unlockAdvisoryClaim(client: PoolClient, advisoryKey: string): Promise<void> {
  const result = await client.query<AdvisoryLockRow>(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
    [advisoryKey],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error('Model-budget operator-alert advisory claim ownership was lost');
  }
}

class PostgresModelBudgetOperatorAlertClaim implements ModelBudgetOperatorAlertClaim {
  private finished = false;

  constructor(
    private readonly client: PoolClient,
    private readonly identity: ModelBudgetOperatorAlertIdentity,
    readonly attempt: number,
    readonly providerIdempotencyKey: string,
    readonly recovered: boolean,
    private readonly advisoryKey: string,
  ) {}

  async recordDelivery(event: ModelBudgetAlertDeliveryEvent): Promise<void> {
    if (this.finished) throw new Error('Model-budget operator-alert claim is already settled');
    try {
      validateDeliveryEvent(this.identity, event);
      await this.client.query('BEGIN');
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
      const nextState = event.status === 'failed' ? 'ready' : 'delivered';
      const settled = await this.client.query(
        `
          UPDATE model_budget_operator_alerts
          SET dispatch_state = $4
          WHERE companion_id = $1
            AND threshold_reason = $2
            AND window_key = $3
            AND dispatch_state = 'dispatching'
            AND dispatch_attempt = $5
            AND dedupe_key = $6
        `,
        [
          this.identity.companionId,
          this.identity.thresholdReason,
          this.identity.windowKey,
          nextState,
          this.attempt,
          this.providerIdempotencyKey,
        ],
      );
      if (settled.rowCount !== 1) {
        throw new Error('Model-budget operator-alert committed outbox claim was lost');
      }
      await this.client.query('COMMIT');
    } catch (error) {
      await this.rollbackAndThrow(error);
    }
    await this.unlockAndRelease();
  }

  async release(): Promise<void> {
    if (this.finished) return;
    await this.unlockAndRelease();
  }

  private async rollbackAndThrow(error: unknown): Promise<never> {
    const failures = [error];
    try {
      await this.client.query('ROLLBACK');
    } catch (caught) {
      failures.push(caught);
    }
    try {
      await this.unlockAndRelease();
    } catch (caught) {
      failures.push(caught);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Model-budget operator-alert evidence settlement failed');
    }
    throw error;
  }

  private async unlockAndRelease(): Promise<void> {
    if (this.finished) return;
    try {
      await unlockAdvisoryClaim(this.client, this.advisoryKey);
      this.finished = true;
      this.client.release();
    } catch (error) {
      this.finished = true;
      this.client.release(true);
      throw error;
    }
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
    const dedupeKey = modelBudgetOperatorAlertDedupeKey(identity);
    const advisoryKey = modelBudgetAlertAdvisoryKey(dedupeKey);
    const createdAtMs = Date.now();
    const client = await this.pool.connect();
    let transactionOpen = false;
    let advisoryClaimHeld = false;
    try {
      await client.query(
        'SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [advisoryKey],
      );
      advisoryClaimHeld = true;
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query(
        `
          INSERT INTO model_budget_operator_alerts (
            companion_id, threshold_reason, window_key, created_at_ms, dedupe_key
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (companion_id, threshold_reason, window_key) DO NOTHING
        `,
        [
          identity.companionId,
          identity.thresholdReason,
          identity.windowKey,
          createdAtMs,
          dedupeKey,
        ],
      );
      const locked = await client.query<AlertAuthorityRow>(
        `
          SELECT
            companion_id AS "companionId",
            dedupe_key AS "dedupeKey",
            dispatch_state AS "dispatchState",
            dispatch_attempt AS "dispatchAttempt"
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
      if (row.dedupeKey !== dedupeKey) {
        throw new Error('Model-budget operator-alert durable idempotency key drifted');
      }
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
      const evidenceAttempt = Number(summary.attemptCount);
      if (!Number.isSafeInteger(evidenceAttempt) || evidenceAttempt < 0) {
        throw new Error('Model-budget operator-alert evidence attempt counter is invalid');
      }
      if (summary.delivered) {
        await client.query(
          `
            UPDATE model_budget_operator_alerts
            SET dispatch_state = 'delivered',
                dispatch_attempt = $4
            WHERE companion_id = $1
              AND threshold_reason = $2
              AND window_key = $3
          `,
          [identity.companionId, identity.thresholdReason, identity.windowKey, evidenceAttempt],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        await unlockAdvisoryClaim(client, advisoryKey);
        advisoryClaimHeld = false;
        client.release();
        return null;
      }
      if (row.dispatchState === 'delivered') {
        throw new Error('Model-budget operator-alert outbox claims delivery without evidence');
      }
      const persistedAttempt = Number(row.dispatchAttempt);
      if (!Number.isSafeInteger(persistedAttempt) || persistedAttempt < 0) {
        throw new Error('Model-budget operator-alert outbox attempt counter is invalid');
      }
      const recovered = row.dispatchState === 'dispatching';
      const attempt = recovered ? persistedAttempt : evidenceAttempt + 1;
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error('Model-budget operator-alert attempt counter is invalid');
      }
      if (recovered && attempt !== evidenceAttempt + 1) {
        throw new Error('Model-budget operator-alert committed outbox attempt is inconsistent');
      }
      const claimed = await client.query(
        `
          UPDATE model_budget_operator_alerts
          SET dispatch_state = 'dispatching',
              dispatch_attempt = $4,
              last_claimed_at_ms = $5
          WHERE companion_id = $1
            AND threshold_reason = $2
            AND window_key = $3
            AND dedupe_key = $6
        `,
        [
          identity.companionId,
          identity.thresholdReason,
          identity.windowKey,
          attempt,
          createdAtMs,
          dedupeKey,
        ],
      );
      if (claimed.rowCount !== 1) {
        throw new Error('Model-budget operator-alert durable outbox claim disappeared');
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return new PostgresModelBudgetOperatorAlertClaim(
        client,
        identity,
        attempt,
        dedupeKey,
        recovered,
        advisoryKey,
      );
    } catch (error) {
      const failures = [error];
      try {
        if (transactionOpen) await client.query('ROLLBACK');
      } catch (caught) {
        failures.push(caught);
      }
      try {
        if (advisoryClaimHeld) await unlockAdvisoryClaim(client, advisoryKey);
        client.release();
      } catch (caught) {
        failures.push(caught);
        client.release(true);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Model-budget operator-alert outbox claim failed');
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
