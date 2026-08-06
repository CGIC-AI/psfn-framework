import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import { DiscordEvidenceLifecycleCoordinator } from '../../boundary/fleet-auth/discord-evidence-lifecycle.js';
import {
  DiscordEvidenceRuntime,
  type DiscordEvidenceObservationPort,
} from '../../boundary/fleet-auth/discord-evidence-runtime.js';
import { FleetEscalationCoordinator } from '../../boundary/fleet-auth/escalation.js';
import {
  verifyAndConsumeHubDeviceAssertion,
  type HubDeviceAssertionExpectedBinding,
  type HubDevicePrincipal,
} from '../../boundary/fleet-auth/hub-device-assertion.js';
import type { HubDeviceHumanAttachmentPort } from '../../boundary/fleet-auth/hub-device-ingress.js';
import {
  GatewayFleetAuthLifecycleCeremonyService,
  type FleetContactAuthorityPort,
} from '../../boundary/fleet-auth/lifecycle-ceremony.js';
import type { PrimaryEmbodimentAuthorityPort } from '../../boundary/fleet-auth/primary-embodiment.js';
import {
  createGatewayRequestCapabilitySigner,
  createRequestCapabilityVerifier,
  type GatewayRequestCapabilitySigner,
  type RequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import type { RequestCapabilityReplayPort } from '../../boundary/fleet-auth/request-capability-replay.js';
import type { TestingHarnessGardenAdminConfig } from '../../channels/backplane/testing-harness-garden-config.js';
import type { GatewayContactLifecycleAuthorityPort } from '../../boundary/gateway/contact-lifecycle-authority.js';
import { GatewayFleetAuthorizationContextResolver } from '../../boundary/gateway/fleet-authorization-context.js';
import { GatewayFleetAuthBroker } from '../../boundary/gateway/fleet-auth-broker.js';
import { GatewayFleetAuthChildAssertionBroker } from '../../boundary/gateway/fleet-auth-child-assertions.js';
import {
  GatewayFleetPortalAuthorizationBatchResolver,
  type FleetPortalAuthorizationBatchPort,
} from '../../boundary/gateway/fleet-portal-authorization.js';
import type { TestingHarnessGardenAuthorizationAuditPort } from '../../boundary/gateway/testing-harness-garden-door.js';
import { GatewayTrustedHostGardenRecoveryService } from '../../boundary/gateway/trusted-host-garden-recovery.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { GatewayFleetAuthAuthorityLifecycleStore } from '../../persistence/postgres/fleet-auth/authority-lifecycle-store.js';
import { FleetAuthAuthorityFloorStore } from '../../persistence/postgres/fleet-auth/authority-floor.js';
import { PostgresFleetAuthorizationContextStore } from '../../persistence/postgres/fleet-auth/authorization-context-store.js';
import { PostgresChildAssertionAuthority } from '../../persistence/postgres/fleet-auth/child-assertion-authority.js';
import type {
  AccountReapprovalRequest,
  AccountReapprovalResult,
} from '../../persistence/postgres/fleet-auth/reapproval.js';
import type {
  CompanionReapprovalRequest,
  CompanionReapprovalResult,
} from '../../persistence/postgres/fleet-auth/companion-reapproval.js';
import { PostgresContactLifecycleAuthorityStore } from '../../persistence/postgres/fleet-auth/contact-lifecycle-authority-store.js';
import { PostgresDiscordEvidenceStore } from '../../persistence/postgres/fleet-auth/discord-evidence-store.js';
import { PostgresFleetEscalationGrantStore } from '../../persistence/postgres/fleet-auth/escalation-grant-store.js';
import {
  createGatewayAccountAuthorityFencePort,
  createGatewayAccountReapprovalAuthority,
  createGatewayCompanionReapprovalAuthority,
  reconcileFleetAuthAuthorityState,
  recordPostgresFleetLifecycleCeremonyDenial,
} from '../../persistence/postgres/fleet-auth/gateway-persistence.js';
import { PostgresHubDeviceAssertionReplayStore } from '../../persistence/postgres/fleet-auth/hub-device-assertion-replay.js';
import { PostgresHubDeviceHumanAttachmentStore } from '../../persistence/postgres/fleet-auth/hub-device-human-attachment-store.js';
import { FleetAuthLifecycleWitnessStore } from '../../persistence/postgres/fleet-auth/lifecycle-witness.js';
import { PostgresFleetAuthBrokerStore } from '../../persistence/postgres/fleet-auth/oauth-session-store.js';
import {
  PostgresFleetPortalAuthorizationStore,
  type PostgresFleetPortalAuthorizationStoreOptions,
} from '../../persistence/postgres/fleet-auth/portal-authorization-store.js';
import type { ProviderRevocationAuthorityPort } from '../../persistence/postgres/fleet-auth/provider-revocation-authority.js';
import { PostgresPrimaryEmbodimentStore } from '../../persistence/postgres/fleet-auth/primary-embodiment-store.js';
import { PostgresRequestCapabilityReplayStore } from '../../persistence/postgres/fleet-auth/request-capability-replay.js';
import {
  assertFleetAuthBackupRestorePrivileges,
  assertFleetAuthRuntimePrivileges,
  hasDurableFleetAuthAuthority,
  migrateFleetAuthSchema,
} from '../../persistence/postgres/fleet-auth/schema.js';
import { PostgresTestingHarnessGardenAuthorizationAudit } from '../../persistence/postgres/fleet-auth/testing-harness-authorization-audit.js';
import {
  resolveGatewayFleetAuthSecrets,
  type FleetAuthConfig,
} from '../../system/config/fleet-auth-config.js';
import { installGatewayFleetAuthPersistenceBoundary } from './fleet-auth-persistence-boundary.js';

/**
 * Gateway composition result. Raw pools remain private; callers receive only
 * bounded stores, ports, and domain operations.
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
  escalation: FleetEscalationCoordinator;
  trustedHostRecovery: GatewayTrustedHostGardenRecoveryService;
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

export function createPostgresFleetAuthorizationContextResolver(options: {
  pool: Pool;
  sessionPepper: string;
  config: FleetAuthConfig;
  knownCompanionIds: readonly string[];
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  now?: () => Date;
}): GatewayFleetAuthorizationContextResolver {
  installGatewayFleetAuthPersistenceBoundary();
  const knownCompanionIds = new Set(options.knownCompanionIds);
  for (const entry of options.config.accountRoster ?? []) {
    if (!knownCompanionIds.has(entry.companionId)) {
      throw new Error(
        `Fleet auth accountRoster references unknown companion ${entry.companionId}`,
      );
    }
  }
  return new GatewayFleetAuthorizationContextResolver(
    new PostgresFleetAuthorizationContextStore({
      pool: options.pool,
      sessionPepper: options.sessionPepper,
      config: options.config,
      providerRevocationAuthority: options.providerRevocationAuthority,
      ...(options.now ? { now: options.now } : {}),
    }),
    options.knownCompanionIds,
  );
}

export function createPostgresFleetPortalAuthorization(
  options: PostgresFleetPortalAuthorizationStoreOptions,
): GatewayFleetPortalAuthorizationBatchResolver {
  installGatewayFleetAuthPersistenceBoundary();
  return new GatewayFleetPortalAuthorizationBatchResolver(
    new PostgresFleetPortalAuthorizationStore(options),
    options.knownCompanionIds,
  );
}

export async function initializeGatewayFleetAuthPersistence(options: {
  config?: FleetAuthConfig;
  credentialVault?: CredentialVaultPort;
  knownCompanionIds: readonly string[];
  protectedRestoreRoots: readonly string[];
  companionDatabaseUrl?: string;
  lifecycleWitnessRoot: string;
  discordEvidenceObserver?: DiscordEvidenceObservationPort;
  testingHarness?: TestingHarnessGardenAdminConfig;
}): Promise<GatewayFleetAuthPersistence | undefined> {
  installGatewayFleetAuthPersistenceBoundary();
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
  await assertFleetAuthRuntimePrivileges(secrets.database.runtimeUrl, config.databaseRoles);
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
      ...(config.accountRoster ? { accountRoster: config.accountRoster } : {}),
    });
    const escalation = new FleetEscalationCoordinator({
      canonicalOrigin: config.canonicalOrigin,
      grantTtlMs: config.ttls.escalationGrantMs,
      store: new PostgresFleetEscalationGrantStore({
        pool,
        sessionPepper: secrets.sessionPepper,
        tokenEncryptionKey: secrets.tokenEncryptionKey,
        providerRevocationAuthority: accountAuthority,
        ...(config.accountRoster ? { accountRoster: config.accountRoster } : {}),
      }),
    });
    const reapproveAccountAuthority = createGatewayAccountReapprovalAuthority(
      pool,
      authorityFloors,
    );
    const authorityLifecycle = new GatewayFleetAuthAuthorityLifecycleStore({
      pool: authorityPool,
      accountAuthority,
      sessionPepper: secrets.sessionPepper,
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
      ...(options.testingHarness ? { testingHarness: options.testingHarness } : {}),
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
      escalation,
      trustedHostRecovery,
      authorityLifecycle,
      contactLifecycleAuthority,
      createLifecycleCeremonies: (contactAuthority) => {
        if (lifecycleCeremoniesCreated) {
          throw new Error('Fleet lifecycle ceremonies are already composed');
        }
        lifecycleCeremoniesCreated = true;
        return new GatewayFleetAuthLifecycleCeremonyService({
          pool,
          sessionPepper: secrets.sessionPepper,
          canonicalOrigin: config.canonicalOrigin,
          lifecycle: authorityLifecycle,
          contactAuthority,
          denialAudit: {
            record: input => recordPostgresFleetLifecycleCeremonyDenial(pool, input),
          },
        });
      },
      ...(discordEvidence ? { discordEvidence } : {}),
      ...(discordEvidenceLifecycle ? { discordEvidenceLifecycle } : {}),
      reapproveAccountAuthority,
      reapproveCompanionAuthority: createGatewayCompanionReapprovalAuthority(
        pool,
        authorityFloors,
      ),
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
