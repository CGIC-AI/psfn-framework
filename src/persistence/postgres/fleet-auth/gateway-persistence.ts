import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialVaultPort } from '../../../boundary/custody/credential-vault.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import { resolveGatewayFleetAuthSecrets } from '../../../system/config/fleet-auth-config.js';
import { createPostgresPool } from '../../postgres.js';
import {
  FleetAuthAuthorityFloorStore,
  type FleetAuthAuthorityFloor,
} from './authority-floor.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  assertFleetAuthBackupRestorePrivileges,
  assertFleetAuthRuntimePrivileges,
  hasDurableFleetAuthAuthority,
  migrateFleetAuthSchema,
} from './schema.js';
import {
  executeAccountReapproval,
  type AccountReapprovalRequest,
  type AccountReapprovalResult,
} from './reapproval.js';
import { FleetAuthLifecycleWitnessStore } from './lifecycle-witness.js';
import {
  verifyAndConsumeHubDeviceAssertion,
  type HubDeviceAssertionExpectedBinding,
  type HubDevicePrincipal,
} from '../../../boundary/fleet-auth/hub-device-assertion.js';
import { PostgresHubDeviceAssertionReplayStore } from './hub-device-assertion-replay.js';

/**
 * Deep gateway-owned fleet-auth persistence. The unrestricted runtime Pool is
 * deliberately NOT exported as the authority interface; callers receive only
 * bounded domain operations. Authority-state mutation must go through those
 * operations (today: constrained trusted-host reapproval), never raw SQL.
 */
export interface GatewayFleetAuthPersistence {
  authorityFloors: FleetAuthAuthorityFloorStore;
  reapproveAccountAuthority(
    request: AccountReapprovalRequest,
  ): Promise<AccountReapprovalResult>;
  verifyAndConsumeHubDeviceAssertion(
    token: string,
    expected: HubDeviceAssertionExpectedBinding,
  ): Promise<HubDevicePrincipal>;
  close(): Promise<void>;
}

interface AuthorityStateRow {
  authority_lineage_id: string | null;
  authority_generation: string;
  global_auth_epoch: string;
  restore_checkpoint: string;
  activation_generation: string;
}

function parseStateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid fleet_auth authority_state.${field}`);
  }
  return parsed;
}

/**
 * Bring restorable database state up to the non-restored floor before any
 * listener can accept authentication. The floor is written first by the
 * trusted-host authority. A database failure therefore leaves authority
 * over-fenced; the next startup retries this transaction.
 */
export async function reconcileFleetAuthAuthorityState(
  pool: Pool,
  floor: FleetAuthAuthorityFloor,
  auditEventId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reconcileFleetAuthAuthorityStateInTransaction(client, floor, auditEventId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction-scoped form used by restore so restored rows, quarantine, epoch
 * advancement, and audit become visible atomically. The caller owns BEGIN,
 * COMMIT, rollback, and any coordinator advisory lock.
 */
export async function reconcileFleetAuthAuthorityStateInTransaction(
  client: PoolClient,
  floor: FleetAuthAuthorityFloor,
  auditEventId: string,
): Promise<void> {
  const result = await client.query<AuthorityStateRow>(`
      SELECT authority_lineage_id, authority_generation, global_auth_epoch,
             restore_checkpoint, activation_generation
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR UPDATE
    `);
  const row = result.rows.at(0);
  if (!row) throw new Error('fleet_auth authority_state singleton is missing');
  const databaseAuthorityGeneration = parseStateInteger(
    row.authority_generation,
    'authority_generation',
  );
  const databaseAuthEpoch = parseStateInteger(row.global_auth_epoch, 'global_auth_epoch');
  const databaseRestoreCheckpoint = parseStateInteger(
    row.restore_checkpoint,
    'restore_checkpoint',
  );
  const databaseActivationGeneration = parseStateInteger(
    row.activation_generation,
    'activation_generation',
  );
  const trusted = floor.trustedHost;
  if (row.authority_lineage_id !== null
    && row.authority_lineage_id !== trusted.lineageId) {
    throw new Error(
      'Restorable fleet_auth authority lineage does not match its non-restored trusted-host floor',
    );
  }
  if (databaseAuthorityGeneration > trusted.authorityGeneration
    || databaseRestoreCheckpoint > trusted.restoreCheckpoint
    || databaseActivationGeneration > trusted.activationGeneration) {
    throw new Error('Restorable fleet_auth authority is ahead of its non-restored trusted-host floor');
  }
  const floorAdvanced = databaseAuthorityGeneration < trusted.authorityGeneration
    || databaseRestoreCheckpoint < trusted.restoreCheckpoint
    || databaseActivationGeneration < trusted.activationGeneration;
  const lineageNeedsBinding = row.authority_lineage_id === null;
  if (!floorAdvanced && !lineageNeedsBinding) return;

  if (!floorAdvanced) {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      SET authority_lineage_id = $1,
          updated_at = clock_timestamp()
      WHERE singleton = TRUE
    `, [trusted.lineageId]);
    return;
  }

  // Durable account rows become non-authoritative restore candidates. Keep
  // explicit revocation states intact while quarantining everything else.
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      SET status = CASE WHEN status = 'revoked' THEN status ELSE 'quarantined' END,
          restore_state = 'quarantined',
          updated_at = clock_timestamp()
    `);
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      SET state = CASE WHEN state = 'revoked' THEN state ELSE 'quarantined' END,
          restore_state = 'quarantined',
          updated_at = clock_timestamp()
    `);
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      SET state = CASE WHEN state = 'revoked' THEN state ELSE 'quarantined' END,
          restore_state = 'quarantined',
          updated_at = clock_timestamp()
    `);
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'quarantined' END,
          restore_state = 'quarantined',
          updated_at = clock_timestamp()
    `);
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
      SET state = CASE WHEN state = 'revoked' THEN state ELSE 'quarantined' END,
          restore_state = 'quarantined',
          updated_at = clock_timestamp()
    `);

  // Ephemeral rows bind the old epoch and are removed before the epoch is
  // published. Provider token custody is intentionally never restorable.
  for (const table of [
    'jit_authorization_grants',
    'step_up_challenges',
    'browser_sessions',
    'provider_token_custody',
    'discord_evidence_snapshots',
    'oauth_transactions',
    'trusted_host_ceremonies',
    'hub_device_assertion_replays',
  ]) {
    await client.query(`DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}."${table}"`);
  }
  const nextEpoch = databaseAuthEpoch + 1;
  await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      SET authority_lineage_id = $1,
          authority_generation = $2,
          global_auth_epoch = $3,
          restore_checkpoint = $4,
          activation_generation = $5,
          updated_at = clock_timestamp()
      WHERE singleton = TRUE
    `, [
      trusted.lineageId,
      trusted.authorityGeneration,
      nextEpoch,
      trusted.restoreCheckpoint,
      trusted.activationGeneration,
    ]);
  await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         authority_generation, global_auth_epoch)
      VALUES ($1, '{"kind":"system","id":"fleet-auth-startup"}'::jsonb,
              'authority.reconcile', 'fleet_auth', 'deny', 'restored_authority_quarantined',
              $2, $3)
    `, [auditEventId, trusted.authorityGeneration, nextEpoch]);
}

export async function initializeGatewayFleetAuthPersistence(options: {
  config?: FleetAuthConfig;
  credentialVault?: CredentialVaultPort;
  protectedRestoreRoots: readonly string[];
  companionDatabaseUrl?: string;
  lifecycleWitnessRoot: string;
}): Promise<GatewayFleetAuthPersistence | undefined> {
  const lifecycleWitness = new FleetAuthLifecycleWitnessStore(options.lifecycleWitnessRoot);
  if (!options.config) {
    lifecycleWitness.recordDisabledIfPresent();
    return undefined;
  }
  const config = options.config;
  if (!options.credentialVault) {
    throw new Error('Fleet auth enabled mode requires the gateway credential vault');
  }
  const secrets = resolveGatewayFleetAuthSecrets({
    config,
    credentialVault: options.credentialVault,
    protectedRestoreRoots: options.protectedRestoreRoots,
    ...(options.companionDatabaseUrl
      ? { companionDatabaseUrl: options.companionDatabaseUrl }
      : {}),
  });
  await migrateFleetAuthSchema({
    databaseUrl: secrets.database.migrationUrl,
    roles: config.databaseRoles,
  });
  await assertFleetAuthRuntimePrivileges(
    secrets.database.runtimeUrl,
    config.databaseRoles,
  );
  await assertFleetAuthBackupRestorePrivileges(
    secrets.database.backupRestoreUrl,
    config.databaseRoles,
  );

  const pool = createPostgresPool(secrets.database.runtimeUrl, {
    applicationName: 'fleet-auth-broker',
    allowExitOnIdle: true,
    max: 8,
  });
  try {
    const databaseHasDurableAuthority = await hasDurableFleetAuthAuthority(pool);
    const authorityFloors = new FleetAuthAuthorityFloorStore(secrets.authorityFloorRoot);
    const existingFloor = authorityFloors.exists() ? authorityFloors.read() : undefined;
    const lifecyclePreparation = lifecycleWitness.prepareEnable(
      existingFloor?.trustedHost.lineageId,
    );
    const floor = authorityFloors.open({
      activationGeneration: config.activationGeneration,
      databaseHasDurableAuthority,
      ...(lifecyclePreparation.lifecycleTransitionId
        ? { lifecycleTransitionId: lifecyclePreparation.lifecycleTransitionId }
        : {}),
    });
    await reconcileFleetAuthAuthorityState(pool, floor, randomUUID());
    lifecycleWitness.publishEnabled(
      lifecyclePreparation,
      floor.trustedHost.lineageId,
      floor.trustedHost.lastLifecycleTransitionId,
    );
    return {
      authorityFloors,
      reapproveAccountAuthority: request => executeAccountReapproval(pool, request),
      verifyAndConsumeHubDeviceAssertion: (token, expected) => verifyAndConsumeHubDeviceAssertion({
        token,
        expected,
        config: config.hubDeviceAssertions,
        replayStore: new PostgresHubDeviceAssertionReplayStore(pool),
      }),
      close: async () => await pool.end(),
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
