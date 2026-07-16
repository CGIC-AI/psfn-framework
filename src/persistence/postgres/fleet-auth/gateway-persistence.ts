import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialVaultPort } from '../../../boundary/custody/credential-vault.js';
import { GatewayFleetAuthBroker } from '../../../boundary/gateway/fleet-auth-broker.js';
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
  PostgresFleetAuthBrokerStore,
  type ProviderRevocationAuthorityPort,
} from './oauth-session-store.js';
import {
  verifyAndConsumeHubDeviceAssertion,
  type HubDeviceAssertionExpectedBinding,
  type HubDevicePrincipal,
} from '../../../boundary/fleet-auth/hub-device-assertion.js';
import { PostgresHubDeviceAssertionReplayStore } from './hub-device-assertion-replay.js';
import { FLEET_AUTH_RECONCILE_FUNCTION_NAME } from './authority-reconciliation-sql.js';
import { DiscordEvidenceRuntime } from '../../../boundary/fleet-auth/discord-evidence-runtime.js';
import type { DiscordEvidenceObservationPort } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { PostgresDiscordEvidenceStore } from './discord-evidence-store.js';
import { DiscordEvidenceLifecycleCoordinator } from '../../../boundary/fleet-auth/discord-evidence-lifecycle.js';

/**
 * Deep gateway-owned fleet-auth persistence. The unrestricted runtime Pool is
 * deliberately NOT exported as the authority interface; callers receive only
 * bounded domain operations. Authority-state mutation must go through those
 * operations (today: constrained trusted-host reapproval), never raw SQL.
 */
export interface GatewayFleetAuthPersistence {
  authorityFloors: FleetAuthAuthorityFloorStore;
  broker: GatewayFleetAuthBroker;
  discordEvidence?: DiscordEvidenceRuntime;
  discordEvidenceLifecycle?: DiscordEvidenceLifecycleCoordinator;
  reapproveAccountAuthority(
    request: AccountReapprovalRequest,
  ): Promise<AccountReapprovalResult>;
  verifyAndConsumeHubDeviceAssertion(
    token: string,
    expected: HubDeviceAssertionExpectedBinding,
  ): Promise<HubDevicePrincipal>;
  close(): Promise<void>;
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
  const trusted = floor.trustedHost;
  const result = await client.query<{ global_auth_epoch: string }>(`
    SELECT global_auth_epoch
    FROM ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}($1, $2, $3, $4, $5)
  `, [
      trusted.lineageId,
      trusted.authorityGeneration,
      trusted.restoreCheckpoint,
      trusted.activationGeneration,
      auditEventId,
    ]);
  const globalAuthEpoch = result.rows.at(0)?.global_auth_epoch;
  if (!globalAuthEpoch) throw new Error('fleet_auth authority reconciliation returned no state');
  parseStateInteger(globalAuthEpoch, 'global_auth_epoch');
}

/** Gateway-internal bridge from browser revocation to the non-restored floor. */
export function createGatewayProviderRevocationAuthorityPort(
  authorityFloors: FleetAuthAuthorityFloorStore,
): ProviderRevocationAuthorityPort {
  // Read on every validation for cross-process advances, while retaining the
  // highest observed generation so this gateway can never accept a regression.
  let observedAuthorityGeneration = authorityFloors.read().trustedHost.authorityGeneration;
  const observeAuthorityGeneration = (): number => {
    observedAuthorityGeneration = Math.max(
      observedAuthorityGeneration,
      authorityFloors.read().trustedHost.authorityGeneration,
    );
    return observedAuthorityGeneration;
  };
  return {
    sessionAuthorityGenerationIsCurrent: authorityGeneration => (
      authorityGeneration === observeAuthorityGeneration()
    ),
    fence: async (input) => {
      const fencedFloor = authorityFloors.revokeAccountAuthority({
        kind: 'provider_subject',
        resourceId: `${input.provider}:${input.subjectId}`,
        reason: input.reasonDigest,
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        fencedFloor.trustedHost.authorityGeneration,
      );
      return {
        authorityGeneration: fencedFloor.trustedHost.authorityGeneration,
        reconcile: async (client) => {
          await reconcileFleetAuthAuthorityStateInTransaction(
            client,
            fencedFloor,
            randomUUID(),
          );
          const state = await client.query<{ global_auth_epoch: string }>(`
            SELECT global_auth_epoch
            FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
            WHERE singleton = TRUE
          `);
          const row = state.rows.at(0);
          if (!row) throw new Error('fleet_auth authority_state singleton is missing');
          return {
            globalAuthEpoch: parseStateInteger(row.global_auth_epoch, 'global_auth_epoch'),
          };
        },
      };
    },
  };
}

/**
 * Keep trusted-host reapproval subordinate to the non-restored provider floor.
 * This guard remains authoritative even when a prior database transaction
 * rolled back after publishing its floor tombstone.
 */
export function createGatewayAccountReapprovalAuthority(
  pool: Pool,
  authorityFloors: FleetAuthAuthorityFloorStore,
): GatewayFleetAuthPersistence['reapproveAccountAuthority'] {
  return async (request) => {
    const providerResourceId = `${request.provider}:${request.providerSubjectId}`;
    if (authorityFloors.isAccountAuthorityTombstoned(
      'provider_subject',
      providerResourceId,
    )) {
      throw new Error('Provider subject is permanently tombstoned by non-restored authority');
    }
    return await executeAccountReapproval(pool, request);
  };
}

export async function initializeGatewayFleetAuthPersistence(options: {
  config?: FleetAuthConfig;
  credentialVault?: CredentialVaultPort;
  protectedRestoreRoots: readonly string[];
  companionDatabaseUrl?: string;
  lifecycleWitnessRoot: string;
  discordEvidenceObserver?: DiscordEvidenceObservationPort;
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
  const authorityPool = createPostgresPool(secrets.database.backupRestoreUrl, {
    applicationName: 'fleet-auth-authority-coordinator',
    allowExitOnIdle: true,
    max: 2,
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
    await reconcileFleetAuthAuthorityState(authorityPool, floor, randomUUID());
    lifecycleWitness.publishEnabled(
      lifecyclePreparation,
      floor.trustedHost.lineageId,
      floor.trustedHost.lastLifecycleTransitionId,
    );
    const providerRevocationAuthority = createGatewayProviderRevocationAuthorityPort(authorityFloors);
    const brokerStore = new PostgresFleetAuthBrokerStore({
      pool,
      providerAuthorityPool: authorityPool,
      sessionPepper: secrets.sessionPepper,
      tokenEncryptionKey: secrets.tokenEncryptionKey,
      providerRevocationAuthority,
    });
    let discordEvidence: DiscordEvidenceRuntime | undefined;
    let discordEvidenceLifecycle: DiscordEvidenceLifecycleCoordinator | undefined;
    if (config.discordEvidenceMappings.length > 0) {
      const discordEvidenceStore = new PostgresDiscordEvidenceStore(pool, providerRevocationAuthority);
      discordEvidence = new DiscordEvidenceRuntime({
        config,
        observer: options.discordEvidenceObserver ?? {
          observe: async () => ({ status: 'bot_absent' }),
        },
        store: discordEvidenceStore,
      });
      discordEvidenceLifecycle = new DiscordEvidenceLifecycleCoordinator({
        config,
        runtime: discordEvidence,
        store: discordEvidenceStore,
        sessionAuthority: brokerStore,
      });
      await discordEvidenceLifecycle.start();
    }
    const broker = new GatewayFleetAuthBroker({
      config: options.config,
      store: brokerStore,
      oauthClientSecret: secrets.oauthClientSecret,
      sessionPepper: secrets.sessionPepper,
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
    });
    return {
      authorityFloors,
      broker,
      ...(discordEvidence ? { discordEvidence } : {}),
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
      reapproveAccountAuthority: createGatewayAccountReapprovalAuthority(pool, authorityFloors),
      verifyAndConsumeHubDeviceAssertion: (token, expected) => verifyAndConsumeHubDeviceAssertion({
        token,
        expected,
        config: config.hubDeviceAssertions,
        replayStore: new PostgresHubDeviceAssertionReplayStore(pool),
      }),
      close: async () => {
        await discordEvidenceLifecycle?.close();
        await Promise.all([pool.end(), authorityPool.end()]);
      },
    };
  } catch (error) {
    await Promise.all([
      pool.end().catch(() => undefined),
      authorityPool.end().catch(() => undefined),
    ]);
    throw error;
  }
}
