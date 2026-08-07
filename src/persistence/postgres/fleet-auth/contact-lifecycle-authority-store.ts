import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GatewayContactLifecycleAuthorityPort } from '../../../boundary/gateway/contact-lifecycle-authority.js';
import {
  contactAuthorityLifecycleIntentDigest,
  contactAuthorityLifecycleRequestDigest,
  parseContactAuthorityLifecycleRequest,
  parseContactAuthorityLifecycleResult,
  type ContactAuthorityLifecycleAction,
  type ContactAuthorityLifecycleRequest,
  type ContactAuthorityLifecycleResult,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import { isRfc4122Uuid } from '../../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { appendAccountAuthorityFloorProjection } from './authority-floor-projection.js';
import type { AccountAuthorityFencePort } from './provider-revocation-authority.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import {
  applyContactLifecycleDestructiveFence,
  contactLifecycleFloorResources,
  lockContactLifecycleAffectedAuthority,
} from './contact-lifecycle-authority-mutations.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

interface IntentRow {
  companion_id: string;
  intent_digest: string;
  action: ContactAuthorityLifecycleAction;
  state: 'active' | 'released' | 'terminal' | 'quarantined';
  restore_state: 'live' | 'quarantined';
}

interface ReceiptRow {
  request_digest: string;
  result: unknown;
  restore_state: 'live' | 'quarantined';
}

const DESTRUCTIVE = new Set<ContactAuthorityLifecycleAction>([
  'contact.merge',
  'contact.delete',
  'contact.discord_unlink',
  'contact.identity_conflict',
]);
const PERMANENT = new Set<ContactAuthorityLifecycleAction>([
  'contact.merge',
  'contact.delete',
  'contact.discord_unlink',
]);

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth contact authority ${field}`);
  }
  return parsed;
}

export class PostgresContactLifecycleAuthorityStore
implements GatewayContactLifecycleAuthorityPort {
  private readonly pool: Pool;
  private readonly accountAuthority: AccountAuthorityFencePort;
  private readonly reconcileExternalFloor: () => Promise<void>;
  private readonly now: () => Date;

  constructor(options: {
    pool: Pool;
    accountAuthority: AccountAuthorityFencePort;
    reconcileExternalFloor: () => Promise<void>;
    now?: () => Date;
  }) {
    this.pool = options.pool;
    this.accountAuthority = options.accountAuthority;
    this.reconcileExternalFloor = options.reconcileExternalFloor;
    this.now = options.now ?? (() => new Date());
  }

  async executeForCompanion(
    authenticatedCompanionId: string,
    input: unknown,
  ): Promise<ContactAuthorityLifecycleResult> {
    if (!isRfc4122Uuid(authenticatedCompanionId)) {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'invalid_authenticated_companion',
      );
    }
    let request: ContactAuthorityLifecycleRequest;
    try {
      request = parseContactAuthorityLifecycleRequest(input);
    } catch (error) {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'invalid_v1_request',
        { cause: error },
      );
    }
    await this.reconcileIfExternalFloorIsAhead();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        request.intentId,
      ]);
      const authority = await this.lockAuthority(client);
      const intentDigest = contactAuthorityLifecycleIntentDigest(request);
      const requestDigest = contactAuthorityLifecycleRequestDigest(request);
      const existing = await this.readIntent(client, request.intentId);
      if (existing) {
        if (existing.companion_id !== authenticatedCompanionId) {
          throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
            'cross_companion_intent_reuse',
          );
        }
        if (!timingSafeStringEqual(existing.intent_digest, intentDigest)
          || existing.action !== request.action) {
          throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
            'changed_intent_reuse',
          );
        }
        if (existing.restore_state !== 'live' || existing.state === 'quarantined') {
          throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
            'restored_intent_quarantined',
          );
        }
        const replay = await this.readReceipt(
          client,
          authenticatedCompanionId,
          request.intentId,
          request.phase,
        );
        if (replay) {
          if (replay.restore_state !== 'live'
            || !timingSafeStringEqual(replay.request_digest, requestDigest)) {
            throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
              'changed_phase_reuse',
            );
          }
          await client.query('COMMIT');
          return parseContactAuthorityLifecycleResult(replay.result);
        }
      } else if (request.phase === 'finalize') {
        throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
          'prepare_receipt_required',
        );
      } else {
        await this.createIntent(client, authenticatedCompanionId, request, intentDigest, authority);
      }

      const result = request.phase === 'prepare'
        ? await this.prepare(client, authenticatedCompanionId, request, authority)
        : await this.finalize(client, authenticatedCompanionId, request, authority, existing);
      await this.writeReceipt(client, authenticatedCompanionId, request, requestDigest, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError) {
        throw error;
      }
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'contact_authority_failed',
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  private async reconcileIfExternalFloorIsAhead(): Promise<void> {
    const result = await this.pool.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state WHERE singleton = TRUE
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority_state is missing');
    if (!this.accountAuthority.sessionAuthorityGenerationIsCurrent(
      integer(row.authority_generation, 'authority_generation'),
    )) {
      await this.reconcileExternalFloor();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<AuthorityRow> {
    const result = await client.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE FOR UPDATE
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority_state is missing');
    if (!this.accountAuthority.sessionAuthorityGenerationIsCurrent(
      integer(row.authority_generation, 'authority_generation'),
    )) {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'external_floor_pending_reconciliation',
      );
    }
    return row;
  }

  private async readIntent(client: PoolClient, intentId: string): Promise<IntentRow | undefined> {
    const result = await client.query<IntentRow>(`
      SELECT companion_id, intent_digest, action, state, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
      WHERE intent_id = $1 FOR UPDATE
    `, [intentId]);
    return result.rows.at(0);
  }

  private async readReceipt(
    client: PoolClient,
    companionId: string,
    intentId: string,
    phase: 'prepare' | 'finalize',
  ): Promise<ReceiptRow | undefined> {
    const result = await client.query<ReceiptRow>(`
      SELECT request_digest, result, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_receipts
      WHERE companion_id = $1 AND intent_id = $2 AND phase = $3
    `, [companionId, intentId, phase]);
    return result.rows.at(0);
  }

  private async createIntent(
    client: PoolClient,
    companionId: string,
    request: ContactAuthorityLifecycleRequest,
    intentDigest: string,
    authority: AuthorityRow,
  ): Promise<void> {
    const companion = await client.query(`
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
      WHERE companion_id = $1 AND lifecycle = 'active' AND restore_state = 'live'
      FOR UPDATE
    `, [companionId]);
    if (companion.rowCount !== 1) {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'companion_authority_inactive',
      );
    }
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
        (companion_id, intent_id, schema_version, intent_digest, action,
         contact_id, canonical_contact_id, provider_subject_id, state,
         authority_generation, restore_state, created_at, updated_at)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'active', $8, 'live', $9, $9)
    `, [
      companionId,
      request.intentId,
      intentDigest,
      request.action,
      request.contactId,
      request.canonicalContactId ?? null,
      request.providerSubjectId ?? null,
      authority.authority_generation,
      this.now(),
    ]);
    const permanent = PERMANENT.has(request.action);
    const resources: Array<{
      kind: 'contact' | 'provider_subject'; id: string; terminalFence: boolean;
    }> = [
      { kind: 'contact', id: request.contactId, terminalFence: permanent },
    ];
    if (request.canonicalContactId) {
      resources.push({ kind: 'contact', id: request.canonicalContactId, terminalFence: false });
    }
    if (request.providerSubjectId) {
      resources.push({
        kind: 'provider_subject',
        id: request.providerSubjectId,
        terminalFence: request.action === 'contact.discord_unlink',
      });
    }
    for (const resource of resources) {
      const conflict = await client.query(`
        SELECT 1
        FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resources AS resource
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents AS intent
          USING (companion_id, intent_id)
        WHERE resource.kind = $2 AND resource.resource_id = $3
          AND (resource.companion_id = $1 OR resource.kind = 'provider_subject')
          AND (intent.state IN ('active', 'quarantined')
            OR (intent.state = 'terminal' AND resource.terminal_fence)
            OR intent.restore_state = 'quarantined')
        LIMIT 1
      `, [companionId, resource.kind, resource.id]);
      if ((conflict.rowCount ?? 0) > 0) {
        throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
          'contact_resource_fenced',
        );
      }
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resources
          (companion_id, intent_id, kind, resource_id, terminal_fence)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        companionId,
        request.intentId,
        resource.kind,
        resource.id,
        resource.terminalFence,
      ]);
    }
  }

  private async prepare(
    client: PoolClient,
    companionId: string,
    request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
    authority: AuthorityRow,
  ): Promise<ContactAuthorityLifecycleResult> {
    let nextAuthority = integer(authority.authority_generation, 'authority_generation');
    let nextEpoch = integer(authority.global_auth_epoch, 'global_auth_epoch');
    let status: ContactAuthorityLifecycleResult['status'] = 'reserved';
    if (DESTRUCTIVE.has(request.action)) {
      const affected = await lockContactLifecycleAffectedAuthority(
        client,
        companionId,
        request,
      );
      status = affected.length === 0 ? 'no_binding' : 'prepared';
      if (PERMANENT.has(request.action)) {
        const floorResources = contactLifecycleFloorResources(companionId, request, affected);
        const fenced = await this.accountAuthority.fenceMany({
          resources: floorResources as ReadonlyArray<{
            kind: 'companion' | 'principal' | 'provider_subject' | 'contact_binding' | 'role_grant' | 'contact_authority_fence';
            resourceId: string;
          }>,
          reasonDigest: contactAuthorityLifecycleIntentDigest(request),
          at: this.now(),
        });
        nextAuthority = fenced.authorityGeneration;
        if (nextAuthority !== integer(authority.authority_generation, 'authority_generation') + 1) {
          throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
            'non_restored_authority_race',
          );
        }
        // Project immediately on a separate committed connection. If the
        // enclosing mutation later rolls back, every SQL activation path still
        // observes the externally published non-restored floor until startup
        // reconciliation advances and quarantines the database copy.
        await this.publishFloorProjection(floorResources, nextAuthority);
        await appendAccountAuthorityFloorProjection(client, floorResources, nextAuthority);
      }
      if (affected.length > 0) {
        nextEpoch += 1;
        await applyContactLifecycleDestructiveFence({
          client,
          companionId,
          request,
          affected,
          authorityGeneration: nextAuthority,
          nextEpoch,
          now: this.now,
        });
      }
      if (nextAuthority !== integer(authority.authority_generation, 'authority_generation')
        || nextEpoch !== integer(authority.global_auth_epoch, 'global_auth_epoch')) {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
          SET authority_generation = $1, global_auth_epoch = $2, updated_at = $3
          WHERE singleton = TRUE
        `, [nextAuthority, nextEpoch, this.now()]);
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
        SET authority_generation = $3, updated_at = $4
        WHERE companion_id = $1 AND intent_id = $2
      `, [companionId, request.intentId, nextAuthority, this.now()]);
    }
    return await this.auditResult(client, companionId, request, status, nextAuthority, nextEpoch);
  }

  private async publishFloorProjection(
    resources: Parameters<typeof appendAccountAuthorityFloorProjection>[1],
    authorityGeneration: number,
  ): Promise<void> {
    const projectionClient = await this.pool.connect();
    try {
      await projectionClient.query('BEGIN');
      await appendAccountAuthorityFloorProjection(
        projectionClient,
        resources,
        authorityGeneration,
      );
      await projectionClient.query('COMMIT');
    } catch (error) {
      await projectionClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      projectionClient.release();
    }
  }

  private async finalize(
    client: PoolClient,
    companionId: string,
    request: Extract<ContactAuthorityLifecycleRequest, { phase: 'finalize' }>,
    authority: AuthorityRow,
    existing: IntentRow | undefined,
  ): Promise<ContactAuthorityLifecycleResult> {
    if (!existing || existing.state !== 'active') {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'intent_not_active',
      );
    }
    const prepared = await this.readReceipt(client, companionId, request.intentId, 'prepare');
    if (!prepared || prepared.restore_state !== 'live') {
      throw new fleetAuthPersistenceBoundaryValues.ContactLifecycleAuthorityDeniedError(
        'prepare_receipt_required',
      );
    }
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents
      SET state = $3, updated_at = $4
      WHERE companion_id = $1 AND intent_id = $2 AND state = 'active'
    `, [
      companionId,
      request.intentId,
      PERMANENT.has(request.action) ? 'terminal' : 'released',
      this.now(),
    ]);
    return await this.auditResult(
      client,
      companionId,
      request,
      'finalized',
      integer(authority.authority_generation, 'authority_generation'),
      integer(authority.global_auth_epoch, 'global_auth_epoch'),
    );
  }

  private async auditResult(
    client: PoolClient,
    companionId: string,
    request: ContactAuthorityLifecycleRequest,
    status: ContactAuthorityLifecycleResult['status'],
    authorityGeneration: number,
    globalAuthEpoch: number,
  ): Promise<ContactAuthorityLifecycleResult> {
    const auditEventId = randomUUID();
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, authority_generation, global_auth_epoch, correlation_id,
         occurred_at, decision_context)
      VALUES ($1, $2::jsonb, $3, $4, 'allow', $5, $6, $7, $8, $9, $10, $11::jsonb)
    `, [
      auditEventId,
      JSON.stringify({ kind: 'system_companion', boundary: 'contact_authority_lifecycle_v1' }),
      request.action,
      `contact_digest:${contactAuthorityLifecycleIntentDigest(request)}`,
      `contact_authority_${status}`,
      companionId,
      authorityGeneration,
      globalAuthEpoch,
      request.intentId,
      this.now(),
      JSON.stringify({ schemaVersion: 1, phase: request.phase, status }),
    ]);
    return {
      schemaVersion: 1,
      intentId: request.intentId,
      phase: request.phase,
      action: request.action,
      status,
      authorityGeneration,
      globalAuthEpoch,
      auditEventId,
    };
  }

  private async writeReceipt(
    client: PoolClient,
    companionId: string,
    request: ContactAuthorityLifecycleRequest,
    requestDigest: string,
    result: ContactAuthorityLifecycleResult,
  ): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_receipts
        (companion_id, intent_id, phase, request_digest, result,
         authority_generation, global_auth_epoch, audit_event_id, restore_state,
         created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'live', $9)
    `, [
      companionId,
      request.intentId,
      request.phase,
      requestDigest,
      JSON.stringify(result),
      result.authorityGeneration,
      result.globalAuthEpoch,
      result.auditEventId,
      this.now(),
    ]);
  }
}
