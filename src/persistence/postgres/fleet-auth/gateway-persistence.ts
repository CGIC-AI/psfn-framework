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
import {
  executeCompanionReapproval,
  type CompanionReapprovalRequest,
  type CompanionReapprovalResult,
} from './companion-reapproval.js';
import { FleetAuthLifecycleWitnessStore } from './lifecycle-witness.js';
import {
  PostgresFleetAuthBrokerStore,
} from './oauth-session-store.js';
import type {
  AccountAuthorityFencePort,
  ProviderRevocationAuthorityPort,
} from './provider-revocation-authority.js';
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
import { GatewayFleetAuthAuthorityLifecycleStore } from './authority-lifecycle-store.js';
import { replaceAccountAuthorityFloorProjection } from './authority-floor-projection.js';
import { createPostgresFleetAuthorizationContextResolver } from './authorization-context.js';
import { reconcilePendingCompanionReadd } from './companion-readd-reconciliation.js';
import type { GatewayContactLifecycleAuthorityPort } from '../../../boundary/gateway/contact-lifecycle-authority.js';
import { PostgresContactLifecycleAuthorityStore } from './contact-lifecycle-authority-store.js';
import type { HubDeviceHumanAttachmentPort } from '../../../boundary/fleet-auth/hub-device-ingress.js';
import { PostgresHubDeviceHumanAttachmentStore } from './hub-device-human-attachment-store.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type GatewayRequestCapabilitySigner,
  type RequestCapabilityVerifier,
} from '../../../boundary/fleet-auth/request-capability.js';
import type { RequestCapabilityReplayPort } from '../../../boundary/fleet-auth/request-capability-replay.js';
import { PostgresRequestCapabilityReplayStore } from './request-capability-replay.js';
import { GatewayFleetAuthChildAssertionBroker } from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import { PostgresChildAssertionAuthority } from './child-assertion-authority.js';
import type { PrimaryEmbodimentAuthorityPort } from '../../../boundary/fleet-auth/primary-embodiment.js';
import { PostgresPrimaryEmbodimentStore } from './primary-embodiment-store.js';

/**
 * Deep gateway-owned fleet-auth persistence. The unrestricted runtime Pool is
 * deliberately NOT exported as the authority interface; callers receive only
 * bounded domain operations. Authority-state mutation must go through those
 * operations (today: constrained trusted-host reapproval), never raw SQL.
 */
export interface GatewayFleetAuthPersistence {
  authorityFloors: FleetAuthAuthorityFloorStore;
  broker: GatewayFleetAuthBroker;
  requestCapabilities: GatewayRequestCapabilitySigner;
  requestCapabilityVerifier: RequestCapabilityVerifier;
  requestCapabilityReplay: RequestCapabilityReplayPort;
  childAssertions: GatewayFleetAuthChildAssertionBroker;
  primaryEmbodiments: PrimaryEmbodimentAuthorityPort;
  authorityLifecycle: GatewayFleetAuthAuthorityLifecycleStore;
  contactLifecycleAuthority: GatewayContactLifecycleAuthorityPort;
  discordEvidence?: DiscordEvidenceRuntime;
  discordEvidenceLifecycle?: DiscordEvidenceLifecycleCoordinator;
  reapproveAccountAuthority(
    request: AccountReapprovalRequest,
  ): Promise<AccountReapprovalResult>;
  reapproveCompanionAuthority(
    request: CompanionReapprovalRequest,
  ): Promise<CompanionReapprovalResult>;
  verifyAndConsumeHubDeviceAssertion(
    token: string,
    expected: HubDeviceAssertionExpectedBinding,
  ): Promise<HubDevicePrincipal>;
  attachHubDeviceHuman(
    input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0],
  ): ReturnType<HubDeviceHumanAttachmentPort['attach']>;
  fenceHubDeviceAttachment(
    input: Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0],
  ): ReturnType<HubDeviceHumanAttachmentPort['fenceDevice']>;
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
  // Serialize projection replacement with both reapproval procedures. They
  // lock this singleton before consulting the projection, so no caller can
  // authorize against the prior committed floor while reconciliation swaps it.
  await client.query(`
    SELECT 1
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
    FOR UPDATE
  `);
  await replaceAccountAuthorityFloorProjection(client, trusted);
  if (await reconcilePendingCompanionReadd(client, floor, auditEventId)) return;
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
  return createGatewayAccountAuthorityFencePort(authorityFloors);
}

export function createGatewayAccountAuthorityFencePort(
  authorityFloors: FleetAuthAuthorityFloorStore,
): AccountAuthorityFencePort {
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
          const state = await client.query<{ global_auth_epoch: string }>(`
            UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
            SET authority_generation = $1,
                global_auth_epoch = global_auth_epoch + 1,
                updated_at = $2
            WHERE singleton = TRUE AND authority_generation = $1::bigint - 1
            RETURNING global_auth_epoch
          `, [fencedFloor.trustedHost.authorityGeneration, input.at]);
          const row = state.rows.at(0);
          if (!row) {
            throw new Error('fleet_auth authority changed during provider revocation');
          }
          return {
            globalAuthEpoch: parseStateInteger(row.global_auth_epoch, 'global_auth_epoch'),
          };
        },
      };
    },
    fenceMany: async (input) => {
      const fencedFloor = authorityFloors.revokeAccountAuthorities({
        resources: input.resources.map(resource => ({
          ...resource,
          reason: input.reasonDigest,
        })),
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        fencedFloor.trustedHost.authorityGeneration,
      );
      return { authorityGeneration: fencedFloor.trustedHost.authorityGeneration };
    },
    beginCompanionReadd: async input => {
      const lineage = authorityFloors.beginCompanionAuthorityReadd({
        ...input,
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        lineage.authorityGeneration,
      );
      return lineage;
    },
    findCompanionReadd: companionId => authorityFloors.findCompanionAuthorityReadd(companionId),
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
    const resources = [
      ['provider_subject', `${request.provider}:${request.providerSubjectId}`],
      ['principal', request.principalId],
      ['companion', request.companionId],
      ['contact_binding', request.bindingId],
      ['role_grant', request.roleGrantId],
    ] as const;
    if (resources.some(([kind, resourceId]) => (
      authorityFloors.isAccountAuthorityTombstoned(kind, resourceId)
    ))) {
      throw new Error('Account authority is permanently tombstoned by non-restored authority');
    }
    return await executeAccountReapproval(pool, request);
  };
}

export function createGatewayCompanionReapprovalAuthority(
  pool: Pool,
  authorityFloors: FleetAuthAuthorityFloorStore,
): GatewayFleetAuthPersistence['reapproveCompanionAuthority'] {
  return async request => {
    if (!authorityFloors.companionAuthorityLineageIsCurrent({
      companionId: request.companionId,
      lineageId: request.lineageId,
      lineageGeneration: request.lineageGeneration,
    })) {
      throw new Error('Companion authority lineage is not current in non-restored authority');
    }
    return await executeCompanionReapproval(pool, request);
  };
}

export async function initializeGatewayFleetAuthPersistence(options: {
  config?: FleetAuthConfig;
  credentialVault?: CredentialVaultPort;
  knownCompanionIds: readonly string[];
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
  const knownCompanionIds = [...options.knownCompanionIds];
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
  const activeRequestCapabilityKey = config.verifierKeys.find(key => key.status === 'active')!;
  const requestCapabilities = createGatewayRequestCapabilitySigner({
    issuer: activeRequestCapabilityKey.issuer,
    kid: secrets.assertionSigningKid,
    privateKeyPem: secrets.assertionPrivateKeyPem,
    ttlSeconds: config.ttls.internalAssertionMs / 1_000,
  });
  const requestCapabilityVerifier = createRequestCapabilityVerifier({
    issuer: activeRequestCapabilityKey.issuer,
    maxTtlSeconds: config.ttls.internalAssertionMs / 1_000,
    keys: config.verifierKeys,
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
    const accountAuthority = createGatewayAccountAuthorityFencePort(authorityFloors);
    const brokerStore = new PostgresFleetAuthBrokerStore({
      pool,
      providerAuthorityPool: authorityPool,
      sessionPepper: secrets.sessionPepper,
      tokenEncryptionKey: secrets.tokenEncryptionKey,
      providerRevocationAuthority: accountAuthority,
    });
    const authorityLifecycle = new GatewayFleetAuthAuthorityLifecycleStore({
      pool: authorityPool,
      accountAuthority,
    });
    const contactLifecycleAuthority = new PostgresContactLifecycleAuthorityStore({
      pool: authorityPool,
      accountAuthority,
      reconcileExternalFloor: async () => {
        await reconcileFleetAuthAuthorityState(
          authorityPool,
          authorityFloors.read(),
          randomUUID(),
        );
      },
    });
    const authorizationContextResolver = createPostgresFleetAuthorizationContextResolver({
      pool,
      sessionPepper: secrets.sessionPepper,
      config,
      knownCompanionIds,
      providerRevocationAuthority: accountAuthority,
    });
    let discordEvidence: DiscordEvidenceRuntime | undefined;
    let discordEvidenceLifecycle: DiscordEvidenceLifecycleCoordinator | undefined;
    if (config.discordEvidenceMappings.length > 0) {
      const discordEvidenceStore = new PostgresDiscordEvidenceStore(pool, accountAuthority);
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
      authorizationContextResolver,
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
    });
    const hubDeviceHumanAttachments = new PostgresHubDeviceHumanAttachmentStore({
      pool,
      resolveAuthorizationContext: input => broker.resolveAuthorizationContext(input),
    });
    const requestCapabilityReplay = new PostgresRequestCapabilityReplayStore(pool);
    const primaryEmbodiments = new PostgresPrimaryEmbodimentStore({ pool });
    const childAssertions = new GatewayFleetAuthChildAssertionBroker({
      verifier: requestCapabilityVerifier,
      signer: requestCapabilities,
      replay: requestCapabilityReplay,
      authority: new PostgresChildAssertionAuthority(pool, config, accountAuthority),
    });
    return {
      authorityFloors,
      broker,
      requestCapabilities,
      requestCapabilityVerifier,
      requestCapabilityReplay,
      childAssertions,
      primaryEmbodiments,
      authorityLifecycle,
      contactLifecycleAuthority,
      ...(discordEvidence ? { discordEvidence } : {}),
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
      reapproveAccountAuthority: createGatewayAccountReapprovalAuthority(pool, authorityFloors),
      reapproveCompanionAuthority: createGatewayCompanionReapprovalAuthority(pool, authorityFloors),
      verifyAndConsumeHubDeviceAssertion: (token, expected) => verifyAndConsumeHubDeviceAssertion({
        token,
        expected,
        config: config.hubDeviceAssertions,
        replayStore: new PostgresHubDeviceAssertionReplayStore(pool),
      }),
      attachHubDeviceHuman: input => hubDeviceHumanAttachments.attach(input),
      fenceHubDeviceAttachment: input => hubDeviceHumanAttachments.fenceDevice(input),
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
