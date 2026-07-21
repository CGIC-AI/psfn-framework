import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialVaultPort } from '../../../boundary/custody/credential-vault.js';
import {
  FleetAuthBrokerError,
  GatewayFleetAuthBroker,
  type VerifiedFirstOwnerAssurance,
} from '../../../boundary/gateway/fleet-auth-broker.js';
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
import { FleetWebAuthnUvBoundary } from '../../../boundary/fleet-auth/webauthn-uv.js';
import { FleetJitStepUpCoordinator } from '../../../boundary/fleet-auth/jit-step-up.js';
import { PostgresFleetJitStepUpStore } from './jit-step-up-store.js';
import type { FleetPortalAuthorizationBatchPort } from '../../../boundary/gateway/fleet-portal-authorization.js';
import { createPostgresFleetPortalAuthorization } from './portal-authorization-store.js';
import { TrustedHostPasskeyCeremonyService } from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import { PostgresTrustedHostPasskeyCeremonyStore } from './trusted-host-passkey-ceremony-store.js';
import { GatewayTrustedHostGardenRecoveryService } from '../../../boundary/gateway/trusted-host-garden-recovery.js';
import {
  GatewayFleetAuthLifecycleCeremonyService,
  type FleetContactAuthorityPort,
  type FleetLifecycleCeremonyDenialAuditPort,
} from '../../../boundary/fleet-auth/lifecycle-ceremony.js';
import { TrustedHostAccountReapprovalService } from '../../../boundary/fleet-auth/trusted-host-account-reapproval.js';
import { PostgresAccountReapprovalCeremonyStore } from './account-reapproval-ceremony-store.js';
import { TrustedHostProviderRecoveryService } from '../../../boundary/fleet-auth/trusted-host-provider-recovery.js';
import { PostgresTrustedHostProviderRecoveryStore } from './trusted-host-provider-recovery-store.js';
import type { TestingHarnessGardenAuthorizationAuditPort } from '../../../boundary/gateway/testing-harness-garden-door.js';
import { PostgresTestingHarnessGardenAuthorizationAudit } from './testing-harness-authorization-audit.js';

/**
 * Deep gateway-owned fleet-auth persistence. The unrestricted runtime Pool is
 * deliberately NOT exported as the authority interface; callers receive only
 * bounded domain operations. Authority-state mutation must go through those
 * operations (today: constrained trusted-host reapproval), never raw SQL.
 */
export interface GatewayFleetAuthPersistence {
  authorityFloors: FleetAuthAuthorityFloorStore;
  broker: GatewayFleetAuthBroker;
  portalAuthorization: FleetPortalAuthorizationBatchPort;
  requestCapabilities: GatewayRequestCapabilitySigner;
  requestCapabilityVerifier: RequestCapabilityVerifier;
  requestCapabilityReplay: RequestCapabilityReplayPort;
  testingHarnessGardenAuthorizationAudit: TestingHarnessGardenAuthorizationAuditPort;
  childAssertions: GatewayFleetAuthChildAssertionBroker;
  primaryEmbodiments: PrimaryEmbodimentAuthorityPort;
  jitStepUp: FleetJitStepUpCoordinator;
  passkeyCeremonies: TrustedHostPasskeyCeremonyService;
  trustedHostRecovery: GatewayTrustedHostGardenRecoveryService;
  accountReapprovalCeremonies: TrustedHostAccountReapprovalService;
  providerRecovery: TrustedHostProviderRecoveryService;
  authorityLifecycle: GatewayFleetAuthAuthorityLifecycleStore;
  contactLifecycleAuthority: GatewayContactLifecycleAuthorityPort;
  createLifecycleCeremonies(
    contactAuthority: FleetContactAuthorityPort,
  ): GatewayFleetAuthLifecycleCeremonyService;
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

async function auditFirstOwnerContactAuthorityDenial(
  pool: Pool,
  input: VerifiedFirstOwnerAssurance,
  reasonCode: 'contact_authority_unavailable' | 'contact_authority_mismatch',
): Promise<void> {
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
  const eventId = randomUUID();
  const result = await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       companion_id, principal_id, authority_generation, global_auth_epoch,
       occurred_at, decision_id, ceremony_id, decision_context)
    SELECT $1, $2::jsonb, 'authority.first_owner', 'first-owner-contact-authority',
           'deny', $3, $4, $5, authority_generation, global_auth_epoch,
           clock_timestamp(), $1, $6, $7::jsonb
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
  `, [
    eventId,
    JSON.stringify({ kind: 'trusted_host', id: 'first_owner' }),
    reasonCode,
    input.companionId,
    input.principalId,
    input.ceremonyId,
    JSON.stringify({
      schemaVersion: 1,
      ceremonyDigest: sha256(input.ceremonyId),
      principalDigest: sha256(input.principalId),
      providerSubjectDigest: sha256(input.providerSubjectId),
      companionDigest: sha256(input.companionId),
      contactDigest: sha256(input.contactId),
      decision: 'deny',
      reasonCode,
    }),
  ]);
  if (result.rowCount !== 1) {
    throw new FleetAuthBrokerError(
      'first_owner_denial_audit_failed',
      503,
      'First-owner contact-authority denial audit could not be persisted',
    );
  }
}

async function auditLifecycleCeremonyDenial(
  pool: Pool,
  input: Parameters<FleetLifecycleCeremonyDenialAuditPort['record']>[0],
): Promise<void> {
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
  const eventId = randomUUID();
  const request = input.request;
  const result = await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       companion_id, principal_id, authority_generation, global_auth_epoch,
       occurred_at, decision_id, ceremony_id, reason_digest, decision_context)
    SELECT $1, $2::jsonb, $3, 'lifecycle-ceremony', 'deny', $4,
           $5, NULL, authority_generation, global_auth_epoch,
           clock_timestamp(), $1, $6, $7, $8::jsonb
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
  `, [
    eventId,
    JSON.stringify({ kind: 'fleet_gateway', id: 'lifecycle_ceremony' }),
    request.action,
    input.reasonCode,
    request.companionId,
    request.ceremonyId,
    sha256(request.reason),
    JSON.stringify({
      schemaVersion: 1,
      action: request.action,
      ceremonyDigest: sha256(request.ceremonyId),
      companionDigest: sha256(request.companionId),
      requestDigest: sha256(JSON.stringify(request)),
      ...('targetPrincipalId' in request
        ? { targetPrincipalDigest: sha256(request.targetPrincipalId) }
        : {}),
      decision: 'deny',
      reasonCode: input.reasonCode,
    }),
  ]);
  if (result.rowCount !== 1) {
    throw new Error('Fleet lifecycle denial audit insert failed');
  }
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
    recoverProvider: async input => {
      const recoveredFloor = authorityFloors.recoverProviderAuthority({
        ...input,
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        recoveredFloor.trustedHost.authorityGeneration,
      );
      return { authorityGeneration: recoveredFloor.trustedHost.authorityGeneration };
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
    const webAuthn = new FleetWebAuthnUvBoundary({
      canonicalOrigin: config.canonicalOrigin,
      rpId: new URL(config.canonicalOrigin).hostname,
      rpName: 'PSFN Fleet',
      timeoutMs: config.ttls.stepUpChallengeMs,
      authority: authorityFloors,
    });
    const jitStepUp = new FleetJitStepUpCoordinator({
      canonicalOrigin: config.canonicalOrigin,
      challengeTtlMs: config.ttls.stepUpChallengeMs,
      grantTtlMs: config.ttls.jitGrantMs,
      store: new PostgresFleetJitStepUpStore({
        pool,
        sessionPepper: secrets.sessionPepper,
        tokenEncryptionKey: secrets.tokenEncryptionKey,
        providerRevocationAuthority: accountAuthority,
        passkeyAuthority: authorityFloors,
      }),
      webAuthn,
      readCredentialFloorGeneration: () => authorityFloors.readPasskeys().generation,
    });
    const passkeyCeremonies = new TrustedHostPasskeyCeremonyService({
      canonicalOrigin: config.canonicalOrigin,
      rpId: new URL(config.canonicalOrigin).hostname,
      ttlMs: config.ttls.stepUpChallengeMs,
      store: new PostgresTrustedHostPasskeyCeremonyStore({
        authorityPool,
        sessionPepper: secrets.sessionPepper,
        tokenEncryptionKey: secrets.tokenEncryptionKey,
        providerRevocationAuthority: accountAuthority,
        passkeyAuthority: authorityFloors,
      }),
      authority: authorityFloors,
      webAuthn,
    });
    const reapproveAccountAuthority = createGatewayAccountReapprovalAuthority(pool, authorityFloors);
    const accountReapprovalCeremonies = new TrustedHostAccountReapprovalService({
      canonicalOrigin: config.canonicalOrigin,
      rpId: new URL(config.canonicalOrigin).hostname,
      ttlMs: config.ttls.stepUpChallengeMs,
      store: new PostgresAccountReapprovalCeremonyStore({
        authorityPool,
        sessionPepper: secrets.sessionPepper,
        tokenEncryptionKey: secrets.tokenEncryptionKey,
        providerRevocationAuthority: accountAuthority,
        passkeyAuthority: authorityFloors,
      }),
      authority: authorityFloors,
      webAuthn,
      reapprove: reapproveAccountAuthority,
    });
    const authorityLifecycle = new GatewayFleetAuthAuthorityLifecycleStore({
      pool: authorityPool,
      accountAuthority,
      sessionPepper: secrets.sessionPepper,
    });
    const providerRecovery = new TrustedHostProviderRecoveryService({
      canonicalOrigin: config.canonicalOrigin,
      rpId: new URL(config.canonicalOrigin).hostname,
      ttlMs: config.ttls.stepUpChallengeMs,
      store: new PostgresTrustedHostProviderRecoveryStore({
        authorityPool,
        sessionPepper: secrets.sessionPepper,
        tokenEncryptionKey: secrets.tokenEncryptionKey,
        providerRevocationAuthority: accountAuthority,
        passkeyAuthority: authorityFloors,
      }),
      authority: authorityFloors,
      webAuthn,
      execute: async input => {
        const result = await authorityLifecycle.execute({
          verification: 'gateway_verified',
          action: 'provider.recover',
          decisionId: input.decisionId,
          ceremonyId: input.ceremonyId,
          actor: input.principal,
          actorSession: input.actorSession,
          target: input.principal,
          companionId: input.companionId,
          unavailableProvider: {
            provider: 'discord',
            subjectId: input.currentProviderSubjectId,
            authorityGeneration: input.currentProviderAuthorityGeneration,
          },
          newProvider: input.newProvider,
          recovery: {
            oneTimeCredential: input.oneTimeCredential,
            confirmation: 'provider.recover',
            webAuthnReceipt: input.webAuthnReceipt,
            credentialIdHash: input.credentialIdHash,
            credentialGeneration: input.credentialGeneration,
            credentialFloorGeneration: input.completedCredentialFloorGeneration,
          },
          authorityGeneration: input.authorityGeneration,
          globalAuthEpoch: input.globalAuthEpoch,
          reasonDigest: input.reasonDigest,
          decidedAt: input.decidedAt,
        });
        return {
          decisionId: result.decisionId,
          authorityGeneration: result.authorityGeneration,
          globalAuthEpoch: result.globalAuthEpoch,
        };
      },
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
    let lifecycleContactAuthority: FleetContactAuthorityPort | undefined;
    let lifecycleCeremoniesCreated = false;
    const authorizationContextResolver = createPostgresFleetAuthorizationContextResolver({
      pool,
      sessionPepper: secrets.sessionPepper,
      config,
      knownCompanionIds,
      providerRevocationAuthority: accountAuthority,
    });
    const portalAuthorization = createPostgresFleetPortalAuthorization({
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
      firstOwnerAssurance: {
        verify: input => passkeyCeremonies.verifyFirstOwner(input),
      },
      firstOwnerContactAuthority: {
        verify: async input => {
          const snapshot = await lifecycleContactAuthority?.read({
            companionId: input.companionId,
            contactId: input.contactId,
            providerSubjectId: input.providerSubjectId,
          });
          const denialReason = !snapshot
            ? 'contact_authority_unavailable' as const
            : snapshot.contactId !== input.contactId
                || snapshot.providerSubjectId !== input.providerSubjectId
              ? 'contact_authority_mismatch' as const
              : undefined;
          if (denialReason) {
            await auditFirstOwnerContactAuthorityDenial(pool, input, denialReason);
            throw new FleetAuthBrokerError(
              denialReason === 'contact_authority_unavailable'
                ? 'first_owner_contact_authority_unavailable'
                : 'first_owner_binding_mismatch',
              409,
              'Exact first-owner contact authority is unavailable',
            );
          }
          return snapshot!;
        },
      },
      authorizationContextResolver,
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
    });
    const hubDeviceHumanAttachments = new PostgresHubDeviceHumanAttachmentStore({
      pool,
      resolveAuthorizationContext: input => broker.resolveAuthorizationContext(input),
    });
    const requestCapabilityReplay = new PostgresRequestCapabilityReplayStore(pool);
    const testingHarnessGardenAuthorizationAudit =
      new PostgresTestingHarnessGardenAuthorizationAudit({
        pool,
        sessionPepper: secrets.sessionPepper,
      });
    const trustedHostRecovery = new GatewayTrustedHostGardenRecoveryService({
      configuredCredential: secrets.trustedHostRecoveryCredential,
      knownCompanionIds: new Set(knownCompanionIds),
      signer: requestCapabilities,
      verifier: requestCapabilityVerifier,
      replay: requestCapabilityReplay,
      authority: authorityFloors,
    });
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
      portalAuthorization,
      requestCapabilities,
      requestCapabilityVerifier,
      requestCapabilityReplay,
      testingHarnessGardenAuthorizationAudit,
      childAssertions,
      primaryEmbodiments,
      jitStepUp,
      passkeyCeremonies,
      trustedHostRecovery,
      accountReapprovalCeremonies,
      providerRecovery,
      authorityLifecycle,
      contactLifecycleAuthority,
      createLifecycleCeremonies: (contactAuthority) => {
        if (lifecycleCeremoniesCreated) {
          throw new Error('Fleet lifecycle ceremonies are already composed');
        }
        lifecycleCeremoniesCreated = true;
        lifecycleContactAuthority = contactAuthority;
        return new GatewayFleetAuthLifecycleCeremonyService({
          pool,
          sessionPepper: secrets.sessionPepper,
          canonicalOrigin: config.canonicalOrigin,
          lifecycle: authorityLifecycle,
          jitStepUp,
          contactAuthority,
          denialAudit: {
            record: input => auditLifecycleCeremonyDenial(pool, input),
          },
          ...(config.accountRoster ? { accountRoster: config.accountRoster } : {}),
          ...(config.accountRosterSatisfiesStepUp !== undefined
            ? { accountRosterSatisfiesStepUp: config.accountRosterSatisfiesStepUp }
            : {}),
        });
      },
      ...(discordEvidence ? { discordEvidence } : {}),
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
      reapproveAccountAuthority,
      reapproveCompanionAuthority: createGatewayCompanionReapprovalAuthority(pool, authorityFloors),
      verifyAndConsumeHubDeviceAssertion: (token, expected) => verifyAndConsumeHubDeviceAssertion({
        token,
        expected,
        config: config.hubDeviceAssertions,
        replayStore: new PostgresHubDeviceAssertionReplayStore(pool),
        sessionPepper: secrets.sessionPepper,
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
