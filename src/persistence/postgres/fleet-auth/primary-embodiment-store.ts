import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  PrimaryEmbodimentAuthorityPort,
  PrimaryEmbodimentHandoffDeniedError,
  PrimaryEmbodimentSnapshot,
} from '../../../boundary/fleet-auth/primary-embodiment.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import {
  FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_NAME,
} from './primary-embodiment-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

const AUDIT_DOMAIN = 'fleet-auth:primary-embodiment-audit:v1\0';

interface PrimaryEmbodimentRow {
  decision?: 'allow' | 'deny';
  reason_code?: string;
  companion_id: string;
  generation: string;
  version: string;
  current_attachment_id: string | null;
  current_device_id: string | null;
  current_enrollment_version: string | null;
  current_hub_session_id: string | null;
  last_decision_id: string | null;
  last_decision: 'handoff' | 'invalidated' | null;
  last_reason: string | null;
  decided_at: Date | null;
}

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

function integer(value: string, field: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid primary embodiment ${field}`);
  }
  return parsed;
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256').update(AUDIT_DOMAIN);
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function emptySnapshot(companionId: string): PrimaryEmbodimentSnapshot {
  return Object.freeze({
    companionId,
    generation: 0,
    version: 0,
    current: null,
    lastDecision: null,
  });
}

function snapshot(row: PrimaryEmbodimentRow): PrimaryEmbodimentSnapshot {
  const current = row.current_attachment_id
    && row.current_device_id
    && row.current_enrollment_version
    && row.current_hub_session_id
    ? Object.freeze({
        attachmentId: row.current_attachment_id,
        deviceId: row.current_device_id,
        enrollmentVersion: integer(row.current_enrollment_version, 'enrollment version', 1),
        hubSessionId: row.current_hub_session_id,
      })
    : null;
  const lastDecision = row.last_decision_id && row.last_decision && row.last_reason && row.decided_at
    ? Object.freeze({
        decisionId: row.last_decision_id,
        decision: row.last_decision,
        reason: row.last_reason as NonNullable<PrimaryEmbodimentSnapshot['lastDecision']>['reason'],
        decidedAt: row.decided_at.toISOString(),
      })
    : null;
  return Object.freeze({
    companionId: row.companion_id,
    generation: integer(row.generation, 'generation', 0),
    version: integer(row.version, 'version', 0),
    current,
    lastDecision,
  });
}

export class PostgresPrimaryEmbodimentStore implements PrimaryEmbodimentAuthorityPort {
  constructor(private readonly options: {
    pool: Pool;
    now?: () => Date;
    randomId?: () => string;
  }) {}

  async read(companionId: string): Promise<PrimaryEmbodimentSnapshot> {
    if (!isRfc4122Uuid(companionId)) throw new Error('Invalid primary embodiment companion ID');
    const result = await this.options.pool.query<PrimaryEmbodimentRow>(`
      SELECT companion_id, generation, version, current_attachment_id, current_device_id,
             current_enrollment_version, current_hub_session_id, last_decision_id,
             last_decision, last_reason, decided_at
      FROM ${FLEET_AUTH_SCHEMA_NAME}.primary_embodiment_authority
      WHERE companion_id = $1
    `, [companionId]);
    const row = result.rows.at(0);
    return row ? snapshot(row) : emptySnapshot(companionId);
  }

  async handoff(
    input: Parameters<PrimaryEmbodimentAuthorityPort['handoff']>[0],
  ): Promise<PrimaryEmbodimentSnapshot> {
    if (!isRfc4122Uuid(input.companionId)
      || !isRfc4122Uuid(input.decisionId)
      || !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration < 0
      || input.attachment.channel.companionId !== input.companionId
      || input.attachment.deviceActor.principal.companionId !== input.companionId) {
      throw new fleetAuthPersistenceBoundaryValues.PrimaryEmbodimentHandoffDeniedError(
        'attachment_not_current',
      );
    }
    const actorPrincipalId = input.attachment.actor.kind === 'human'
      ? input.attachment.actor.principalId
      : null;
    const device = input.attachment.deviceActor;
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const authority = await this.lockAuthority(client);
      const occurredAt = this.options.now?.() ?? new Date();
      const result = await client.query<PrimaryEmbodimentRow>(`
        SELECT * FROM ${FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_NAME}(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
      `, [
        input.companionId,
        input.attachment.attachmentId,
        input.decisionId,
        device.principal.deviceId,
        device.principal.enrollmentVersion,
        device.principal.sessionId,
        device.connectionId,
        input.expectedGeneration,
        actorPrincipalId,
        input.reason,
        occurredAt,
      ]);
      const row = result.rows.at(0);
      if (!row?.decision || !row.reason_code) {
        throw new Error('Primary embodiment handoff procedure returned no decision');
      }
      await this.insertAudit(client, {
        input,
        row: { ...row, decision: row.decision, reason_code: row.reason_code },
        authority,
        occurredAt,
      });
      await client.query('COMMIT');
      if (row.decision === 'deny') {
        if (![
          'decision_replay', 'decision_cross_companion', 'stale_generation',
          'attachment_not_current', 'human_authority_required', 'already_primary',
        ].includes(row.reason_code)) {
          throw new Error('Primary embodiment handoff returned an unknown denial');
        }
        throw new fleetAuthPersistenceBoundaryValues.PrimaryEmbodimentHandoffDeniedError(
          row.reason_code as PrimaryEmbodimentHandoffDeniedError['code'],
        );
      }
      return snapshot(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // A SERIALIZABLE serialization failure (SQLSTATE 40001) here means a
      // concurrent handoff won the race on the same authority lock, so this
      // caller's expectedGeneration is now stale. Normalize the raw driver
      // error to the domain denial the sibling stores already surface
      // (portal-authorization-store.ts), rather than leaking a 40001 to
      // callers that only understand PrimaryEmbodimentHandoffDeniedError.
      if (isRecord(error) && error.code === '40001') {
        throw new fleetAuthPersistenceBoundaryValues.PrimaryEmbodimentHandoffDeniedError(
          'stale_generation',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<{
    authorityGeneration: number;
    globalAuthEpoch: number;
  }> {
    const result = await client.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('Primary embodiment authority state is absent');
    return {
      authorityGeneration: integer(row.authority_generation, 'authority generation', 1),
      globalAuthEpoch: integer(row.global_auth_epoch, 'global auth epoch', 1),
    };
  }

  private async insertAudit(client: PoolClient, input: {
    input: Parameters<PrimaryEmbodimentAuthorityPort['handoff']>[0];
    row: PrimaryEmbodimentRow & { decision: 'allow' | 'deny'; reason_code: string };
    authority: { authorityGeneration: number; globalAuthEpoch: number };
    occurredAt: Date;
  }): Promise<void> {
    const eventId = this.options.randomId?.() ?? randomUUID();
    const attachmentActor = input.input.attachment.actor;
    const isHumanActor = attachmentActor.kind === 'human';
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        authority_generation, global_auth_epoch, correlation_id, occurred_at,
        decision_context
      ) VALUES ($1, $2::jsonb, 'primary_embodiment.handoff', $3, $4, $5,
                $6, $7, $8::uuid::text, $9, $10::jsonb)
    `, [
      eventId,
      JSON.stringify({
        kind: 'primary_embodiment_handoff',
        companionDigest: digest(input.input.companionId),
        attachmentDigest: digest(input.input.attachment.attachmentId),
        deviceDigest: digest(input.input.attachment.deviceActor.principal.deviceId),
        actorDigest: isHumanActor
          ? digest(attachmentActor.principalId)
          : digest('guest'),
      }),
      `primary_embodiment:${digest(input.input.companionId)}`,
      input.row.decision,
      input.row.reason_code,
      input.authority.authorityGeneration,
      input.authority.globalAuthEpoch,
      input.input.decisionId,
      input.occurredAt,
      JSON.stringify({
        schemaVersion: 1,
        expectedGeneration: input.input.expectedGeneration,
        resultingGeneration: integer(input.row.generation, 'resulting generation', 0),
        resultingVersion: integer(input.row.version, 'resulting version', 0),
        reason: input.input.reason,
      }),
    ]);
  }
}
