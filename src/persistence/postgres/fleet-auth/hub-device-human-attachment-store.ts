import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  HubDeviceAttachmentRejectedError,
  type HubDeviceHumanAttachment,
  type HubDeviceHumanAttachmentPort,
  type HubHumanActorContext,
} from '../../../boundary/fleet-auth/hub-device-ingress.js';
import {
  FleetAuthorizationDeniedError,
  type FleetAuthorizationContext,
} from '../../../boundary/gateway/fleet-authorization-context.js';
import { isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME } from './companion-authority-lock-sql.js';
import {
  FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_NAME,
  FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_NAME,
} from './hub-device-human-attachment-sql.js';
import { createPositiveIntegerCoercer } from './row-utils.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

const CHANNEL_DIGEST_DOMAIN = 'fleet-auth:hub-device-channel:v1\0';
const AUDIT_DIGEST_DOMAIN = 'fleet-auth:hub-device-attachment-audit:v1\0';
const HUMAN_BINDING_DIGEST_DOMAIN = 'fleet-auth:hub-device-human-binding:v1\0';
const positiveInteger = createPositiveIntegerCoercer('hub-device-attachment');

interface AttachmentFunctionRow {
  decision: 'allow' | 'deny';
  reason_code: string | null;
  disposition: HubDeviceHumanAttachment['disposition'] | null;
  attachment_id: string;
  device_state: 'active' | 'fenced';
  human_state: 'attached' | 'guest' | 'detached';
}

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

export interface PostgresHubDeviceHumanAttachmentStoreOptions {
  pool: Pool;
  resolveAuthorizationContext(input: unknown): Promise<FleetAuthorizationContext>;
  now?: () => Date;
  randomId?: () => string;
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256').update(AUDIT_DIGEST_DOMAIN);
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function channelId(input: {
  assertionDigest: string;
  companionId: string;
  deviceId: string;
  sessionId: string;
  connectionId: string;
}): string {
  const channelDigest = createHash('sha256')
    .update(CHANNEL_DIGEST_DOMAIN)
    .update(input.assertionDigest).update('\0')
    .update(input.companionId).update('\0')
    .update(input.deviceId).update('\0')
    .update(input.sessionId).update('\0')
    .update(input.connectionId)
    .digest('hex');
  return `hub-device:${channelDigest}`;
}

function humanBindingDigest(context: FleetAuthorizationContext): string {
  return createHash('sha256')
    .update(HUMAN_BINDING_DIGEST_DOMAIN)
    .update(JSON.stringify({
      principalId: context.principalId,
      companionId: context.companionId,
      providerSubject: context.providerSubject,
      contact: context.contact,
      operator: context.operator,
      session: context.session,
      authority: context.authority,
    }))
    .digest('hex');
}

export class PostgresHubDeviceHumanAttachmentStore implements HubDeviceHumanAttachmentPort {
  private readonly pool: Pool;
  private readonly resolveAuthorizationContext: PostgresHubDeviceHumanAttachmentStoreOptions['resolveAuthorizationContext'];
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(options: PostgresHubDeviceHumanAttachmentStoreOptions) {
    this.pool = options.pool;
    this.resolveAuthorizationContext = options.resolveAuthorizationContext;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  async attach(
    input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0],
    retried = false,
  ): Promise<HubDeviceHumanAttachment> {
    let human: FleetAuthorizationContext | undefined;
    let humanInvalidated = false;
    if (input.human.kind === 'fleet_browser_session') {
      try {
        human = await this.resolveAuthorizationContext({
          sessionToken: input.human.sessionToken,
          audience: 'fleet',
          companionId: input.connection.companionId,
          action: 'companion.read',
        });
      } catch (error) {
        if (!(error instanceof FleetAuthorizationDeniedError)) throw error;
        humanInvalidated = true;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const authority = await this.lockAuthority(client);
      if (human && !await this.humanAuthorityIsCurrent(client, human, authority)) {
        human = undefined;
        humanInvalidated = true;
      }
      const mode = human ? 'attach'
        : input.human.kind === 'detach' || humanInvalidated ? 'detach'
          : 'guest';
      const serverChannelId = channelId({
        assertionDigest: input.assertionDigest,
        companionId: input.connection.companionId,
        deviceId: input.connection.deviceId,
        sessionId: input.connection.sessionId,
        connectionId: input.connection.connectionId,
      });
      const result = await client.query<AttachmentFunctionRow>(`
        SELECT * FROM ${FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_NAME}(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
        )
      `, [
        this.randomId(),
        input.assertionDigest,
        input.devicePrincipal.jti,
        input.connection.deviceId,
        input.connection.enrollmentVersion,
        input.connection.placeId ?? null,
        input.devicePrincipal.keyId,
        input.connection.companionId,
        input.connection.sessionId,
        input.connection.connectionId,
        serverChannelId,
        mode,
        human ? humanBindingDigest(human) : null,
        human?.principalId ?? null,
        human?.session.recordId ?? null,
        human?.providerSubject.subjectId ?? null,
        human?.contact.bindingId ?? null,
        human?.contact.contactId ?? null,
        human?.contact.bindingVersion ?? null,
        human?.operator.grantId ?? null,
        human?.operator.role ?? null,
        human?.operator.grantVersion ?? null,
        human?.authority.authorityGeneration ?? null,
        human?.authority.globalAuthEpoch ?? null,
        this.now(),
      ]);
      const row = result.rows.at(0);
      if (!row) throw new Error('Hub device attachment procedure returned no decision');
      await this.insertAudit(client, {
        row,
        input,
        human,
        authority,
        action: mode === 'detach' ? 'hub_device_human.detach' : 'hub_device_human.attach',
        reason: humanInvalidated ? 'human_authority_invalidated' : row.reason_code,
      });
      await client.query('COMMIT');
      if (row.decision === 'deny') {
        if (row.reason_code !== 'device_binding_mismatch'
          && row.reason_code !== 'device_fenced'
          && row.reason_code !== 'human_binding_mismatch') {
          throw new Error('Hub device attachment procedure returned an unknown denial');
        }
        throw new HubDeviceAttachmentRejectedError(row.reason_code);
      }
      if (!row.disposition) throw new Error('Hub device attachment allow omitted disposition');

      const deviceActor = Object.freeze({
        kind: 'hub_device' as const,
        principal: input.devicePrincipal,
        connectionId: input.connection.connectionId,
      });
      const actor = human && row.human_state === 'attached'
        ? this.humanActor(human)
        : Object.freeze({ kind: 'guest' as const, companionId: input.connection.companionId });
      return Object.freeze({
        attachmentId: row.attachment_id,
        disposition: row.disposition,
        deviceActor,
        actor,
        channel: Object.freeze({
          source: 'server' as const,
          id: serverChannelId,
          companionId: input.connection.companionId,
        }),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // A SERIALIZABLE serialization failure (SQLSTATE 40001) means a
      // concurrent admit for the same channel won the race. Re-run once from
      // the top (re-resolving the human context): the attachment function is
      // replay-aware, so the rerun reports the winner's outcome ('retry')
      // instead of leaking the aborted transaction. A second consecutive
      // conflict still fails closed, matching the sibling fleet-auth stores'
      // 40001 handling (portal-authorization-store.ts).
      if (retried || !isRecord(error) || error.code !== '40001') throw error;
    } finally {
      client.release();
    }
    // SAFETY: acquire the retry client only after finally returned the failed
    // transaction's client, so pool-wide serialization conflicts cannot make
    // every request hold one client while waiting indefinitely for another.
    return await this.attach(input, true);
  }

  async fenceDevice(input: Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const fenced = await client.query<{
        attachment_id: string;
        companion_id: string;
        changed: boolean;
        primary_invalidated: boolean;
      }>(`
        SELECT * FROM ${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_NAME}($1, $2, $3, $4)
      `, [input.assertionDigest, input.connectionId, input.reason, this.now()]);
      for (const row of fenced.rows) {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
            event_id, actor_context, action, resource, decision, reason_code,
            authority_generation, global_auth_epoch, occurred_at
          ) VALUES ($1, $2::jsonb, $3, $4, 'deny', $5, $6, $7, $8)
        `, [
          this.randomId(),
          JSON.stringify({
            kind: 'hub_device_attachment',
            assertionDigest: input.assertionDigest,
            connectionDigest: digest(input.connectionId),
            attachmentDigest: digest(row.attachment_id),
            companionDigest: digest(row.companion_id),
          }),
          'hub_device_human.fence_device',
          `hub_device_attachment:${input.assertionDigest}`,
          input.reason,
          authority.authorityGeneration,
          authority.globalAuthEpoch,
          this.now(),
        ]);
        if (row.changed && row.primary_invalidated) {
          await client.query(`
            INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
              event_id, actor_context, action, resource, decision, reason_code,
              authority_generation, global_auth_epoch, occurred_at
            ) VALUES ($1, $2::jsonb, 'primary_embodiment.invalidate', $3,
                      'deny', $4, $5, $6, $7)
          `, [
            this.randomId(),
            JSON.stringify({
              kind: 'primary_embodiment_invalidation',
              attachmentDigest: digest(row.attachment_id),
              companionDigest: digest(row.companion_id),
            }),
            `primary_embodiment:${digest(row.companion_id)}`,
            input.reason === 'enrollment_authority_changed'
              ? 'enrollment_revoked'
              : 'device_revoked',
            authority.authorityGeneration,
            authority.globalAuthEpoch,
            this.now(),
          ]);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private humanActor(context: FleetAuthorizationContext): Readonly<HubHumanActorContext> {
    return Object.freeze({
      kind: 'human',
      principalId: context.principalId,
      companionId: context.companionId,
      providerSubject: Object.freeze({ ...context.providerSubject }),
      contact: Object.freeze({ ...context.contact }),
      operator: Object.freeze({ ...context.operator }),
      session: Object.freeze({
        recordId: context.session.recordId,
        authorityGeneration: context.authority.authorityGeneration,
        globalAuthEpoch: context.authority.globalAuthEpoch,
      }),
    });
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
    if (!row) throw new Error('Hub device attachment authority state is absent');
    return {
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      globalAuthEpoch: positiveInteger(row.global_auth_epoch, 'global_auth_epoch'),
    };
  }

  private async humanAuthorityIsCurrent(
    client: PoolClient,
    context: FleetAuthorizationContext,
    authority: { authorityGeneration: number; globalAuthEpoch: number },
  ): Promise<boolean> {
    const result = await client.query<{ current: boolean }>(`
      SELECT TRUE AS current
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.principal_id = principal.principal_id
       AND subject.provider = 'discord'
       AND subject.subject_id = $3
      JOIN ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}($4) AS companion
        ON companion.companion_id = $4
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
        ON binding.binding_id = $5
       AND binding.principal_id = principal.principal_id
       AND binding.companion_id = companion.companion_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
        ON role_grant.grant_id = $6
       AND role_grant.principal_id = principal.principal_id
       AND role_grant.companion_id = companion.companion_id
      WHERE session.record_id = $1
        AND session.principal_id = $2
        AND session.audience = 'fleet'
        AND session.provider = 'discord'
        AND session.provider_subject_id = $3
        AND session.revoked_at IS NULL AND session.replaced_by IS NULL
        AND session.idle_expires_at > $9 AND session.absolute_expires_at > $9
        AND session.authn_version = principal.authn_version
        AND session.authn_version = $14
        AND session.authz_version = principal.authz_version
        AND session.authz_version = $15
        AND session.binding_version = principal.binding_version
        AND session.binding_version = $16
        AND session.grant_version = principal.grant_version
        AND session.grant_version = $17
        AND session.policy_version = principal.policy_version
        AND session.policy_version = $18
        AND session.global_auth_epoch = $8
        AND principal.status = 'active' AND principal.restore_state = 'live'
        AND principal.authority_generation = $7
        AND subject.state = 'active' AND subject.restore_state = 'live'
        AND subject.authority_generation = $7
        AND companion.lifecycle = 'active' AND companion.restore_state = 'live'
        AND companion.authority_generation = $7
        AND (companion.authority_lineage_id IS NULL OR companion.lineage_floor_current)
        AND binding.state = 'active' AND binding.restore_state = 'live'
        AND binding.version = $10 AND binding.authority_generation = $7
        AND binding.contact_id = $11
        AND role_grant.lifecycle = 'active' AND role_grant.restore_state = 'live'
        AND role_grant.version = $12 AND role_grant.authority_generation = $7
        AND role_grant.role = $13
        AND NOT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases AS alias
          WHERE alias.source_principal_id = principal.principal_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones AS tombstone
          WHERE tombstone.provider = 'discord' AND tombstone.subject_id = subject.subject_id
        )
        AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
          'principal', principal.principal_id::text
        )
        AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
          'provider_subject', 'discord:' || subject.subject_id
        )
        AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
          'contact_binding', binding.binding_id::text
        )
        AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
          'role_grant', role_grant.grant_id::text
        )
      FOR SHARE OF session, principal, subject, binding, role_grant
    `, [
      context.session.recordId,
      context.principalId,
      context.providerSubject.subjectId,
      context.companionId,
      context.contact.bindingId,
      context.operator.grantId,
      authority.authorityGeneration,
      authority.globalAuthEpoch,
      this.now(),
      context.contact.bindingVersion,
      context.contact.contactId,
      context.operator.grantVersion,
      context.operator.role,
      context.session.authnVersion,
      context.session.authzVersion,
      context.session.bindingVersion,
      context.session.grantVersion,
      context.session.policyVersion,
    ]);
    return result.rowCount === 1;
  }

  private async insertAudit(client: PoolClient, input: {
    row: AttachmentFunctionRow;
    input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0];
    human: FleetAuthorizationContext | undefined;
    authority: { authorityGeneration: number; globalAuthEpoch: number };
    action: string;
    reason: string | null;
  }): Promise<void> {
    const actorContext = {
      kind: 'hub_device_attachment',
      assertionDigest: input.input.assertionDigest,
      attachmentDigest: digest(input.row.attachment_id),
      deviceDigest: digest(input.input.connection.deviceId),
      connectionDigest: digest(input.input.connection.connectionId),
      hubSessionDigest: digest(input.input.connection.sessionId),
      companionDigest: digest(input.input.connection.companionId),
      human: input.human ? {
        kind: 'human',
        principalDigest: digest(input.human.principalId),
        sessionDigest: digest(input.human.session.recordId),
      } : { kind: 'guest' },
    };
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        authority_generation, global_auth_epoch, occurred_at
      ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)
    `, [
      this.randomId(),
      JSON.stringify(actorContext),
      input.action,
      `hub_device_attachment:${input.input.assertionDigest}`,
      input.row.decision,
      input.reason,
      input.human?.authority.authorityGeneration ?? input.authority.authorityGeneration,
      input.human?.authority.globalAuthEpoch ?? input.authority.globalAuthEpoch,
      this.now(),
    ]);
  }
}
