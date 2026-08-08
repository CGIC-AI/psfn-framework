// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npx tsx src/app/gateway/main.ts

import '../../shared/utils/load-dotenv.js';
import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../../system/config/load-config.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EventBus } from '../../shared/event-bus.js';
import { ensureRegistryFile } from '../../system/modules/registry.js';
import { attachTerminalDebugObserver } from '../startup/support/terminal-observer.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { EligibilityDecision } from '../../system/capabilities/eligibility.js';
import { resolveGatewayBootstrapInput } from '../../boundary/gateway/bootstrap-input.js';
import type { StartupConfigHydrationDiagnostics } from '../startup/support/bootstrap-helpers.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { RUNTIME_MODE } from '../../system/lifecycle/runtime-mode.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';
import { formatGatewayRpcEndpoint } from '../../boundary/gateway/transport.js';
import { buildGatewayPrivilegedCore } from '../../boundary/gateway/privileged-core.js';
import { ShardWorkloadRegistry } from '../../faculties/shards/workload-registry.js';
import {
  createWelfareGrantVerifier,
  type WelfareGrantVerifier,
} from '../../boundary/gateway/welfare-grant-verifier.js';
import {
  initGatewayChannelSurfaces,
  loadGatewayChannelSurfaces,
  startGatewayChannelSurfaces,
  stopGatewayChannelSurfaces,
  wireGatewayChannelMessages,
} from '../../boundary/gateway/channel-surfaces.js';
import { createGatewayVoiceSurfaces } from '../../boundary/gateway/voice-surfaces.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { runShutdownSequence } from '../startup/support/shutdown-helpers.js';
import {
  createSignalShutdownHandler,
  installSignalHandlers,
  registerProcessErrorHandlers,
} from '../startup/support/signal-shutdown.js';
import { resolveGatewayApiSurfaceBindings, startOptionalGatewayApiServer } from './api-surface.js';
import { createGatewayFleetPortalChannelHealthSource } from './fleet-portal-composition.js';
import { loadSatelliteRegistryConfig } from '../../channels/backplane/satellite-registry.js';
import { assertSatellitePlaceBindings, loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import { GatewayCompanionChannelLane } from '../../boundary/gateway/companion-channels.js';
import { PostgresCompanionPresenceStore } from '../../persistence/postgres/companion-presence-store.js';
import { PostgresIcpSharedAutonomyStore } from '../../persistence/postgres/icp-shared-autonomy-store.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { RootBoundIcpInitiationCausalityAuthority } from '../../boundary/gateway/icp-initiation-causality-authority.js';
import { GatewayIcpLocalPolicyCoordinator } from '../../boundary/gateway/icp-local-policy-coordinator.js';
import { CompanionEventRelay } from '../../channels/backplane/companion-relay/relay.js';
import { CHARGE_POLICY_FILE_NAME } from '../../system/config/charge-policy-config.js';
import {
  ensurePersonalFilesLayout,
  resolveCogSecEventsPath,
  resolveContactBlockListPath,
  resolvePersonalImagesDir,
} from '../../persistence/layout.js';
import { provisionFleetWorkspaces } from '../../persistence/workspaces/provisioning.js';
import { migrateLegacyWorkspaceForFleet } from '../../persistence/workspaces/legacy-workspace-migration.js';
import { logLegacyWorkspaceMigrationResult } from './legacy-workspace-migration-logging.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { createGatewayContactBlockGate } from '../../boundary/gateway/contact-block-gate.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { attachGatewayTurnPerformanceForwarder } from '../../boundary/gateway/turn-performance-forwarder.js';
import { initializeGatewayFleetAuthPersistence } from './fleet-auth-persistence.js';
import { DiscordEvidenceObserverRegistry } from '../../boundary/fleet-auth/discord-evidence-observer-registry.js';
import { requireFleetSsoFleetManifest } from '../../boundary/fleet-auth/fleet-sso-transport.js';
import { assertFleetAuthStandaloneSurfacesUnavailable } from '../../system/config/fleet-auth-standalone-surface-guard.js';
import { resolveGatewayFleetAuthSecrets } from '../../system/config/fleet-auth-config.js';
import { resolveCompanionDatabaseTopology } from '../../system/config/companion-database-config.js';
import { grantFleetModelUsageReadAccess } from '../../persistence/postgres/model-usage-access.js';
import { resolveBackupRuntimeConfig } from '../../persistence/backups/config.js';
import { resolveKubernetesHelmBackupConfig } from '../../persistence/backups/kubernetes-helm.js';
import { migrateFleetAuthSchema } from '../../persistence/postgres/fleet-auth/schema.js';
import { buildFleetAuthBackupCycleOptions } from '../../persistence/backups/fleet-scheduler.js';
import { prepareFleetSharedSchemaRuntime } from '../../persistence/backups/fleet-shared-schema-startup.js';
import {
  assertRestoreVerifyDatabasePreconditions,
} from '../../persistence/backups/restore-verify-preconditions.js';
import {
  DEFAULT_SHARED_WORLD_SCHEMA,
  registerScheduledFleetAuthBackupTask,
  SCHEDULED_BACKUP_TASK_ID,
  SCHEDULED_BACKUP_TASK_NAME,
} from '../../persistence/backups/service.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { createGatewayFleetChargePolicyResolver } from './fleet-charge-policy-resolver.js';
import { parseVerifiedDiscordContactAuthoritySnapshot } from '../../shared/contracts/contact-authority-snapshot.js';
import { evaluateProactiveOutboundTimeGate } from '../../core/intention/proactive-time-gate.js';
import {
  loadTestingHarnessGardenAdminConfig,
  resolveTestingHarnessGardenVerifierConfig,
} from '../../channels/backplane/config.js';
import { resolveOperatorAlertSinkConfiguration } from '../../shared/contracts/operator-alerting.js';
import {
  createBackupFailureAlertHandler,
  createQuarantineExpiryAlertHandler,
  createRepeatedScreeningFailureAlertHandler,
  createScheduledTaskFailureAlertHandler,
} from '../startup/support/operator-alerts.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import type { NotificationPort } from '../../core/tools/ntfy.js';
import {
  awaitOptionalPostgresStoreReadiness,
  awaitPostgresStoreReadiness,
  sealPostgresStoreReadinessBeforeReady,
} from '../../persistence/postgres/runtime-readiness.js';

const log = createComponentLogger('Gateway');

ensureActiveTimezone();

function logStartupHydrationDiagnostics(diagnostics: StartupConfigHydrationDiagnostics): void {
  if (diagnostics.legacySettingsKeys.length > 0) {
    log.error('Startup rejected cross-domain keys in settings.json', {
      keys: diagnostics.legacySettingsKeys,
    });
  }
}

function emitEligibilityDecision(eventBus: EventBus, decision: EligibilityDecision): void {
  eventBus.emit('capability.eligibility', {
    operationKind: decision.operation.kind,
    operationRef: JSON.stringify(decision.operation),
    allowed: decision.allowed,
    reasonCode: decision.reasonCode,
    tier: decision.tier,
    requiredTokens: decision.requiredTokens,
    missingTokens: decision.missingTokens,
    ...(decision.minimumTier ? { minimumTier: decision.minimumTier } : {}),
    timestamp: Date.now(),
  }).catch((error: unknown) => {
    log.warn('Failed to emit capability eligibility telemetry', { error: String(error) });
  });
}

async function main(): Promise<void> {
  const env = process.env;
  const config = loadConfig();
  assertFleetAuthStandaloneSurfacesUnavailable({
    fleetAuthEnabled: config.fleetAuth !== undefined,
    processMode: 'gateway',
    env,
    principalAuthenticationWired: true,
    fleetAuthBootstrapRoutesWired: config.fleetAuth !== undefined,
  });
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });
  await hydrateSecretBearingConfig(config, { env });
  const {
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env,
    logger: log,
  });
  const fleetAuthProtectedRestoreRoots = [
    startupHydration.pathSnapshot.systemDataDir,
    startupHydration.pathSnapshot.companionDataDir,
    startupHydration.pathSnapshot.workspacePath,
    startupHydration.pathSnapshot.runtimePathLayout.backupsDir,
  ];
  const companionDatabaseTopology = config.companionFleet
    ? (() => {
        if (!config.credentialVault || !config.postgresDatabaseUrl) {
          throw new Error(
            'Fleet startup requires its topology credential vault and gateway database credential',
          );
        }
        return resolveCompanionDatabaseTopology({
          fleet: config.companionFleet,
          credentialVault: config.credentialVault,
          gatewayDatabaseUrl: config.postgresDatabaseUrl,
        });
      })()
    : undefined;
  const fleetAuthSecrets = config.fleetAuth && config.credentialVault
    ? resolveGatewayFleetAuthSecrets({
        config: config.fleetAuth,
        credentialVault: config.credentialVault,
        protectedRestoreRoots: fleetAuthProtectedRestoreRoots,
        ...(config.postgresDatabaseUrl
          ? { companionDatabaseUrl: config.postgresDatabaseUrl }
          : {}),
      })
    : undefined;
  if (config.fleetAuth) {
    requireFleetSsoFleetManifest(config.companionFleet);
  }
  const fleetAuthKnownCompanionIds = config.companionFleet?.companions
    .map(companion => companion.companionId) ?? [];
  const discordEvidenceObservers = new DiscordEvidenceObserverRegistry();
  const testingHarnessGardenAdmin = loadTestingHarnessGardenAdminConfig(
    startupHydration.pathSnapshot.systemDataDir,
  );
  const testingHarnessGardenVerifier = resolveTestingHarnessGardenVerifierConfig(
    testingHarnessGardenAdmin,
    env,
  );
  const initializeFleetAuthPersistence = () => initializeGatewayFleetAuthPersistence({
    config: config.fleetAuth,
    credentialVault: config.credentialVault,
    knownCompanionIds: fleetAuthKnownCompanionIds,
    ...(config.postgresDatabaseUrl
      ? { companionDatabaseUrl: config.postgresDatabaseUrl }
      : {}),
    protectedRestoreRoots: fleetAuthProtectedRestoreRoots,
    lifecycleWitnessRoot: startupHydration.pathSnapshot.systemDataDir,
    discordEvidenceObserver: discordEvidenceObservers,
    ...(testingHarnessGardenVerifier && testingHarnessGardenAdmin
      ? { testingHarness: testingHarnessGardenAdmin }
      : {}),
  });
  const fleetAuthPersistence = config.fleetAuth
    ? await awaitPostgresStoreReadiness('fleet_auth', initializeFleetAuthPersistence)
    : await initializeFleetAuthPersistence();
  const sharedSchemaAccessContracts = companionDatabaseTopology
    ? await awaitPostgresStoreReadiness('shared_runtime_authority', () => (
      prepareFleetSharedSchemaRuntime({
        sharedMigrationDatabaseUrl: companionDatabaseTopology.sharedMigration.databaseUrl,
        sharedMigrationRole: companionDatabaseTopology.sharedMigration.role,
        companionDatabases: companionDatabaseTopology.companions.map(entry => ({
          databaseUrl: entry.databaseUrl,
          role: entry.role,
          schema: entry.companion.postgresSchema,
        })),
        sharedSchema: DEFAULT_SHARED_WORLD_SCHEMA,
        ...(config.fleetAuth && fleetAuthSecrets
          ? {
              fleetAuth: {
                backupRestoreDatabaseUrl: fleetAuthSecrets.database.backupRestoreUrl,
                roles: config.fleetAuth.databaseRoles,
              },
            }
          : {}),
      })
    ))
    : undefined;
  const satelliteRegistryConfig = loadSatelliteRegistryConfig(startupHydration.pathSnapshot.systemDataDir);
  const placesRegistryConfig = loadPlacesRegistryConfig(startupHydration.pathSnapshot.systemDataDir);
  assertSatellitePlaceBindings(satelliteRegistryConfig, placesRegistryConfig);
  log.info('Loaded places registry', {
    siteCount: placesRegistryConfig.sites.length,
    placeCount: placesRegistryConfig.places.length,
  });
  logStartupHydrationDiagnostics(startupHydration.diagnostics);
  const bootstrap = resolveGatewayBootstrapInput({
    config,
    env,
    startupHydration,
    satelliteRegistryConfig,
  });
  log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      startupHydration.trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      startupHydration.trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  log.info('Loaded charge policy quotas', {
    runChargeQuotaByLane: startupHydration.chargePolicyConfig.runChargeQuotaByLane,
    sourcePath: `${startupHydration.pathSnapshot.companionDataDir}/${CHARGE_POLICY_FILE_NAME}`,
  });
  if (!bootstrap.diagnostics.workspacePathProvided) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      workspacePath: bootstrap.workspacePath,
    });
  }

  const resolveFleetChargePolicy = config.multiCompanion === true && config.companionFleet
    ? createGatewayFleetChargePolicyResolver({
      companions: config.companionFleet.companions,
      ...(env.CONFIG_DIR ? { seedDir: env.CONFIG_DIR } : {}),
    })
    : null;

  const privilegedCore = await buildGatewayPrivilegedCore({
    config,
    env,
    bootstrap,
    startupHydration,
    logger: log,
    onEligibilityDecision: emitEligibilityDecision,
    ...(resolveFleetChargePolicy
      ? { icpConversationChargePolicyResolver: resolveFleetChargePolicy }
      : {}),
  });
  const {
    eventBus,
    eligibilityGate,
    privilegedServices,
    createGatewayServer,
  } = privilegedCore;
  if (companionDatabaseTopology && companionDatabaseTopology.companions.length > 1) {
    const primary = companionDatabaseTopology.companions[0];
    if (!primary) {
      throw new Error('Fleet model usage startup requires a primary companion database entry');
    }
    const modelUsageStore = privilegedServices.modelUsageStore;
    if (!modelUsageStore) {
      throw new Error('Fleet model usage startup requires its canonical gateway authority');
    }
    await modelUsageStore.waitUntilReady();
    await grantFleetModelUsageReadAccess({
      ownerDatabaseUrl: primary.databaseUrl,
      primarySchema: primary.companion.postgresSchema,
      primaryRole: primary.role,
      followerRoles: companionDatabaseTopology.companions.slice(1).map(entry => entry.role),
    });
  }
  let fleetAuthBackupScheduler: Scheduler | undefined;
  if (config.fleetAuth) {
    const fleetAuthDatabaseRoles = config.fleetAuth.databaseRoles;
    if (!config.companionFleet || !fleetAuthPersistence || !config.credentialVault) {
      throw new Error('Fleet auth backup startup invariants are incomplete');
    }
    if (!config.postgresDatabaseUrl) {
      throw new Error('Fleet auth backup requires the companion PostgreSQL credential');
    }
    const backupConfig = resolveBackupRuntimeConfig({
      dataDir: startupHydration.pathSnapshot.systemDataDir,
      env,
    });
    if (!fleetAuthSecrets || !companionDatabaseTopology || !sharedSchemaAccessContracts) {
      throw new Error('Fleet auth backup requires the complete multi-companion database topology');
    }
    const kubernetesHelm = resolveKubernetesHelmBackupConfig(env);
    const cycleOptions = buildFleetAuthBackupCycleOptions({
      fleet: config.companionFleet,
      systemDataDir: startupHydration.pathSnapshot.systemDataDir,
      backupRestoreDatabaseUrl: fleetAuthSecrets.database.backupRestoreUrl,
      schemaOwnerDatabaseUrl: fleetAuthSecrets.database.migrationUrl,
      roles: {
        ...config.fleetAuth.databaseRoles,
        sharedMigration: companionDatabaseTopology.sharedMigration.role,
      },
      authorityFloors: fleetAuthPersistence.authorityFloors,
      schemaOwnerDatabaseUrls: Object.fromEntries([
        ...companionDatabaseTopology.companions.map(entry => (
          [entry.companion.postgresSchema, entry.databaseUrl] as const
        )),
        [DEFAULT_SHARED_WORLD_SCHEMA, companionDatabaseTopology.sharedMigration.databaseUrl],
      ]),
      schemaAccessContracts: sharedSchemaAccessContracts,
      backupConfig,
      ...(kubernetesHelm ? { kubernetesHelm } : {}),
    });
    if (backupConfig.verifyRestore) {
      const scratchBackupUrl = cycleOptions.fleetBackupOptions.postgres.restoreVerifyDatabaseUrl;
      const scratchMigrationUrl = cycleOptions.restoreVerifySchemaOwnerDatabaseUrl;
      if (!scratchBackupUrl || !scratchMigrationUrl) {
        throw new Error(
          'Fleet auth verifyRestore requires complete derived scratch database credentials',
        );
      }
      await assertRestoreVerifyDatabasePreconditions({
        credentials: [
          {
            label: 'backup',
            databaseUrl: scratchBackupUrl,
            expectedRole: config.fleetAuth.databaseRoles.backupRestore,
          },
          {
            label: 'fleet_auth migration',
            databaseUrl: scratchMigrationUrl,
            expectedRole: config.fleetAuth.databaseRoles.migration,
          },
          ...cycleOptions.schemas.map(contract => ({
            label: `${contract.schema} schema owner`,
            databaseUrl: cycleOptions.scratchSchemaOwnerDatabaseUrls[contract.schema]!,
            expectedRole: contract.ownerRole,
          })),
        ],
      });
      // The scratch database remains operator-provisioned. Once its existence
      // and CREATE/CONNECT grants are proved read-only above, startup
      // idempotently provisions only its fleet_auth schema.
      await awaitPostgresStoreReadiness(
        'fleet_auth',
        () => migrateFleetAuthSchema({
          databaseUrl: scratchMigrationUrl,
          roles: fleetAuthDatabaseRoles,
        }),
      );
    }
    fleetAuthBackupScheduler = new Scheduler(
      eventBus,
      {
        tickIntervalMs: startupHydration.schedulerConfig.tickIntervalMs,
        heartbeatIntervalMs: startupHydration.schedulerConfig.heartbeatIntervalMs,
      },
      { eligibilityGate },
    );
    registerScheduledFleetAuthBackupTask({
      scheduler: fleetAuthBackupScheduler,
      cycleOptions,
      config: backupConfig,
      onBackupFailure: async (error) => {
        await eventBus.emit('backup.failed', {
          taskId: SCHEDULED_BACKUP_TASK_ID,
          taskName: SCHEDULED_BACKUP_TASK_NAME,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      },
    });
    log.info('Gateway-owned fleet auth consistent backups enabled', {
      companionCount: config.companionFleet.companions.length,
      mode: 'consistent-family',
      intervalMs: backupConfig.intervalMs,
      backupRootDir: backupConfig.rootDir,
      verifyRestore: backupConfig.verifyRestore,
      encryption: backupConfig.encryption.mode,
      mirrorDir: backupConfig.mirrorDir || '(none)',
    });
  }
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'gateway' });

  log.info('Initializing...');
  if (startupHydration.systemDataDir !== startupHydration.companionDataDir) {
    log.info('Configured split persistence roots', {
      systemDataDir: startupHydration.systemDataDir,
      companionDataDir: startupHydration.companionDataDir,
    });
  }

  if (bootstrap.gatewayRpcEndpoint.kind === 'unix') {
    mkdirSync(dirname(bootstrap.gatewayRpcEndpoint.socketPath), { recursive: true });
  }
  if (config.companionFleet) {
    const legacyWorkspaceMigration = migrateLegacyWorkspaceForFleet({
      fleet: config.companionFleet,
      legacyWorkspacePath: process.env.WORKSPACE_PATH,
      env: process.env,
    });
    logLegacyWorkspaceMigrationResult(log, legacyWorkspaceMigration);
    provisionFleetWorkspaces(config.companionFleet);
  } else {
    ensurePersonalFilesLayout(bootstrap.workspaceRoot);
  }
  if (bootstrap.workspaceRoot !== bootstrap.gitRepoRoot) {
    log.info('Gateway workspace and git roots diverge', {
      workspaceRoot: bootstrap.workspaceRoot,
      gitRepoRoot: bootstrap.gitRepoRoot,
    });
  }
  if (bootstrap.server.ntfy) {
    log.info('Gateway ntfy notifier configured', {
      baseUrl: bootstrap.server.ntfy.baseUrl,
      defaultTopic: bootstrap.server.ntfy.defaultTopic,
    });
  } else if (bootstrap.diagnostics.ntfyConfigIncomplete) {
    log.warn('ntfy alerts disabled: both NTFY_BASE_URL and NTFY_TOPIC are required');
  }
  if (bootstrap.fullCodebaseReadRoot) {
    log.warn('YOLO runtime mode active: full-codebase fs.read is enabled', {
      runtimeMode: bootstrap.runtimeMode,
      fullCodebaseReadRoot: bootstrap.fullCodebaseReadRoot,
      workspaceWriteScope: bootstrap.workspaceRoot,
    });
  } else {
    log.info('Gateway runtime mode', { runtimeMode: bootstrap.runtimeMode });
  }

  // Ensure the module registry file exists regardless of policy — prevents
  // ENOENT when the REPL sandbox or ModuleLoader reads it for the first time.
  ensureRegistryFile(bootstrap.moduleRegistryAbsolute);

  const channelSurfaces = await loadGatewayChannelSurfaces({
    config,
    bootstrap,
    eventBus,
    eligibilityGate,
    intakeScreeningMode: privilegedCore.intakeScreening.mode,
    intakeScreening: bootstrap.server.multiCompanion.enabled
      ? null
      : privilegedCore.intakeScreening.screeningFor(),
    ...(bootstrap.server.multiCompanion.enabled
      ? {
          intakeScreeningForCompanion: (companionId: CompanionId) =>
            privilegedCore.intakeScreening.screeningFor(companionId),
        }
      : {}),
    log,
    enableDiscordEvidenceLifecycle: fleetAuthPersistence?.discordEvidenceLifecycle !== undefined,
  });
  log.info('Embedding provider initialized', {
    provider: privilegedServices.embeddingProvider.kind,
    dims: privilegedServices.embeddingProvider.dims,
  });
  const { discord, telegram } = channelSurfaces;
  const operatorAlerting = resolveOperatorAlertSinkConfiguration({
    ntfyConfigured: bootstrap.server.ntfy !== undefined,
    telegramEnabled: telegram !== undefined,
    telegramChatId: bootstrap.channelsConfig.telegram.operatorChatId,
  });
  if (operatorAlerting.status === 'unconfigured') {
    log.error('OPERATOR ALERTING IS UNCONFIGURED', {
      warning: operatorAlerting.warning,
      configuredSinks: operatorAlerting.configuredSinks,
    });
  }
  const primaryDiscordCompanionId = bootstrap.channelsConfig.discord.companionId
    ?? (config.companionFleet?.companions.length === 1
      ? config.companionFleet.companions[0]?.companionId
      : undefined);
  const fleetPortalChannelHealthEntries: Array<{
    companionId: string;
    isConnected: () => boolean | undefined;
  }> = channelSurfaces.discordAccounts?.map(account => ({
    companionId: account.companionId,
    isConnected: () => account.adapter.isConnected(),
  })) ?? (primaryDiscordCompanionId
    ? [{
        companionId: primaryDiscordCompanionId,
        isConnected: () => discord.isConnected(),
      }]
    : []);
  const telegramCompanionId = bootstrap.channelsConfig.telegram.companionId
    ?? (config.companionFleet?.companions.length === 1
      ? config.companionFleet.companions[0]?.companionId
      : undefined);
  if (telegram && telegramCompanionId) {
    fleetPortalChannelHealthEntries.push({
      companionId: telegramCompanionId,
      // Telegram currently exposes lifecycle state but no honest live
      // connectivity probe. Preserve that missing signal as unknown.
      isConnected: () => undefined,
    });
  }
  const fleetPortalChannelHealth = createGatewayFleetPortalChannelHealthSource(
    fleetPortalChannelHealthEntries,
  );
  const discordEvidenceLifecycle = fleetAuthPersistence?.discordEvidenceLifecycle;
  if (channelSurfaces.discordAccounts && discordEvidenceLifecycle) {
    for (const account of channelSurfaces.discordAccounts) {
      discordEvidenceObservers.register(account.companionId, account.adapter.discordEvidence);
      discordEvidenceLifecycle.registerCompanionEventSource(
        account.companionId,
        account.adapter.discordEvidence,
      );
    }
  } else if (discordEvidenceLifecycle && primaryDiscordCompanionId) {
    discordEvidenceObservers.register(primaryDiscordCompanionId, discord.discordEvidence);
    discordEvidenceLifecycle.registerCompanionEventSource(
      primaryDiscordCompanionId,
      discord.discordEvidence,
    );
  }

  log.info('Gateway audit persistence backend', {
    persistenceBackend: config.persistenceBackend,
  });

  // ── Create gateway server ──

  // Multi-account discord (W1-P2): one outbound dock per companionId so
  // agent-originated discord sends egress through their own bot identity only.
  const discordAccountDocks = channelSurfaces.discordAccounts
    ? new Map(channelSurfaces.discordAccounts.map(account => [account.companionId, account.adapter]))
    : undefined;

  // ── Inter-companion channel lane (sprint-10 W6) ──
  // Multi-companion only: the gateway owns cross-companion routing. Room
  // membership resolves from shared-schema presence; DM peers validate against
  // the fleet manifest. Flag-off, none of this exists and companion sends fail
  // closed at the RPC surface.
  let companionPresenceStore: PostgresCompanionPresenceStore | null = null;
  let icpAutonomyStore: PostgresIcpSharedAutonomyStore | null = null;
  let icpFatigueRegulationStore: PostgresIcpFatigueRegulationReservationStore | null = null;
  let icpInitiationPolicyAuthority: GatewayIcpLocalPolicyCoordinator | null = null;
  let requestIcpPolicyAgent: (
    companionId: string,
    method: string,
    params: unknown,
  ) => Promise<unknown> = async () => {
    throw new Error('ICP local policy routing is not ready');
  };
  let companionChannelLane: GatewayCompanionChannelLane | undefined;
  if (config.multiCompanion === true) {
    const databaseUrl = config.postgresDatabaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error('Multi-companion inter-companion channels require config.postgresDatabaseUrl');
    }
    if (!config.companionFleet) {
      throw new Error('Multi-companion inter-companion channels require the companions.json fleet manifest');
    }
    if (!resolveFleetChargePolicy) {
      throw new Error('Multi-companion inter-companion channels require fleet charge-policy owners');
    }
    const companionFleet = config.companionFleet;
    const fleetCompanionIds = companionFleet.companions.map((entry) => entry.companionId);
    companionPresenceStore = await awaitPostgresStoreReadiness(
      'companion_presence',
      () => PostgresCompanionPresenceStore.connect(databaseUrl),
    );
    icpAutonomyStore = await awaitPostgresStoreReadiness(
      'icp_shared_autonomy',
      () => PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: fleetCompanionIds,
      }),
    );
    icpFatigueRegulationStore = await awaitPostgresStoreReadiness(
      'icp_fatigue_reservations',
      () => PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl),
    );
    const requiredFatigueRegulationStore = icpFatigueRegulationStore;
    icpInitiationPolicyAuthority = new GatewayIcpLocalPolicyCoordinator({
      requestCompanionAgent: async (companionId, method, params) => (
        await requestIcpPolicyAgent(companionId, method, params)
      ),
      readRelationshipPressure: async ({
        senderCompanionId,
        recipientCompanionId,
        nowMs,
      }) => {
        const regulation = resolveFleetChargePolicy(senderCompanionId)
          .fatigue.socialRegulation;
        const pressure = await requiredFatigueRegulationStore.readInitiationPressure({
          localCompanionId: senderCompanionId,
          peerCompanionId: recipientCompanionId,
          timestampMs: nowMs,
          relationshipPressureHalfLifeMs: regulation.relationshipPressureHalfLifeMs,
          relationshipPressureWindowMs: regulation.relationshipPressureWindowMs,
          unansweredAfterMs: regulation.unansweredInitiationAfterMs,
          declinedPressureUnits: regulation.declinedPressureUnits,
          deferredPressureUnits: regulation.deferredPressureUnits,
          unansweredPressureUnits: regulation.unansweredPressureUnits,
        });
        return pressure.relationshipPressure;
      },
      causalityAuthority: new RootBoundIcpInitiationCausalityAuthority(),
      reportUnavailable: ({ companionIds, operation, error }) => {
        log.warn('Companion-local ICP policy authority unavailable', {
          companionIds: companionIds.join(','),
          operation,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    companionChannelLane = new GatewayCompanionChannelLane({
      placesRegistry: placesRegistryConfig,
      presence: companionPresenceStore,
      fleetCompanionIds: new Set(fleetCompanionIds),
    });
    log.info('Inter-companion channel lane enabled', {
      fleetSize: companionFleet.companions.length,
      placeCount: placesRegistryConfig.places.length,
    });
  }

  // fxt1: gateway-side welfare grant verifier. Re-verifies a
  // caller-asserted `preemptionProtected` LLMWorkSpec against the background-work
  // store (`welfare_claimed = true AND state = 'running'`, scoped to the
  // authenticated companion's schema) before the gate honors it; the RPC
  // handlers strip the flag on any failure (fail closed → preemptable). Absent
  // Postgres ⇒ undefined ⇒ every asserted flag is stripped.
  let welfareGrantVerifier: WelfareGrantVerifier | undefined;
  const welfareVerifierDatabaseUrl = config.postgresDatabaseUrl?.trim();
  if (welfareVerifierDatabaseUrl) {
    const verifier = createWelfareGrantVerifier({
      databaseUrl: welfareVerifierDatabaseUrl,
      ...(config.companionFleet
        ? {
            fleet: config.companionFleet.companions.map(companion => ({
              companionId: companion.companionId,
              postgresSchema: companion.postgresSchema,
            })),
          }
        : (config.postgresSchema?.trim()
          ? { postgresSchema: config.postgresSchema.trim() }
          : {})),
    });
    if (verifier) {
      welfareGrantVerifier = await awaitOptionalPostgresStoreReadiness(
        'welfare_grant_verifier',
        async () => {
          try {
            await verifier.assertReady();
            return verifier;
          } catch (error) {
            await verifier.close();
            throw error;
          }
        },
      );
    }
  }

  const shardWorkloadRegistry = new ShardWorkloadRegistry();
  const gateway = createGatewayServer({
    discordAdapter: discord,
    ...(telegram ? { telegramDock: telegram } : {}),
    ...(bootstrap.channelsConfig.telegram.operatorChatId
      ? { operatorTelegramChatId: bootstrap.channelsConfig.telegram.operatorChatId }
      : {}),
    ...(discordAccountDocks ? { discordAccountDocks } : {}),
    ...(companionChannelLane ? { companionChannels: companionChannelLane } : {}),
    ...(icpAutonomyStore ? { icpAutonomyStore } : {}),
    ...(icpInitiationPolicyAuthority ? { icpInitiationPolicyAuthority } : {}),
    sharedSatelliteQuietHoursAllows: nowMs => evaluateProactiveOutboundTimeGate({
      nowMs,
      quietHours: startupHydration.schedulerConfig.episodicProcessing,
    }).allowed,
    ...(welfareGrantVerifier ? { welfareGrantVerifier } : {}),
    shardApprovalWorkloads: shardWorkloadRegistry,
    ...(fleetAuthPersistence?.contactLifecycleAuthority
      ? { contactLifecycleAuthority: fleetAuthPersistence.contactLifecycleAuthority }
      : {}),
  });
  requestIcpPolicyAgent = async (companionId, method, params) => (
    await gateway.requestCompanionAgent(companionId, method, params)
  );
  const gatewayOperatorNotifier: NotificationPort = {
    notify: async (params) => {
      await gateway.notifyOperator(params);
      return { status: 'sent', topic: 'operator-alert-sinks' };
    },
  };
  const operatorAlertCompanionName = resolveCompanionNameFromConfig(config);
  eventBus.on(
    'backup.failed',
    createBackupFailureAlertHandler(gatewayOperatorNotifier, operatorAlertCompanionName),
  );
  eventBus.on(
    'schedule.task.failed',
    createScheduledTaskFailureAlertHandler(gatewayOperatorNotifier, operatorAlertCompanionName),
  );
  eventBus.on(
    'intake.quarantine.expired',
    createQuarantineExpiryAlertHandler(gatewayOperatorNotifier, operatorAlertCompanionName),
  );
  eventBus.on(
    'intake.screening.fail_closed',
    createRepeatedScreeningFailureAlertHandler({
      notifier: gatewayOperatorNotifier,
      companionName: operatorAlertCompanionName,
      failureThreshold: config.intakeScreeningFailureAlertThreshold,
    }),
  );
  const fleetAuthLifecycleCeremonies = fleetAuthPersistence?.createLifecycleCeremonies({
    read: async ({ companionId, contactId, providerSubjectId }) => {
      const result = await gateway.requestCompanionAgent<unknown>(
        companionId,
        'contact.authority.snapshot',
        { contactId, providerSubjectId },
      );
      return result === null
        ? undefined
        : parseVerifiedDiscordContactAuthoritySnapshot(result);
    },
  });
  const detachTurnPerformanceForwarder = attachGatewayTurnPerformanceForwarder({
    eventBus,
    gateway,
    log,
  });
  const {
    apiHost,
    apiPort,
    adminHost,
    adminPort,
  } = resolveGatewayApiSurfaceBindings(process.env);
  const voiceSurfaces = await createGatewayVoiceSurfaces({
    config,
    eventBus,
    gateway,
    discord,
    eligibilityGate,
    log,
  });
  // htm9.16: companion-initiated block gate. The block list is a system-owned,
  // reversible store the agent-side contact tool writes; the gateway reads it to
  // drop blocked DMs before they cross the RPC boundary. Soft blocks emit an
  // operator-visible cogsec event on each enforcement.
  const contactBlockGate = createGatewayContactBlockGate({
    blockList: new ContactBlockListStore(
      resolveContactBlockListPath(startupHydration.companionDataDir),
    ),
    cogSecEvents: new CogSecEventStore(
      resolveCogSecEventsPath(startupHydration.companionDataDir),
    ),
    log,
  });
  wireGatewayChannelMessages({
    discord,
    ...(channelSurfaces.discordAccounts
      ? { discordAccounts: channelSurfaces.discordAccounts }
      : {}),
    telegram,
    gateway,
    serializeMessage,
    blockGate: contactBlockGate,
  });

  // ── Start everything ──

  await initGatewayChannelSurfaces(channelSurfaces);
  const postgresReadiness = await sealPostgresStoreReadinessBeforeReady();
  if (postgresReadiness.degraded.length > 0) {
    log.warn('Optional PostgreSQL stores degraded at gateway startup', {
      stores: postgresReadiness.degraded.map(entry => entry.store).join(','),
      mismatches: postgresReadiness.degraded.map(entry => entry.mismatch).join('; '),
    });
  }
  gateway.start();
  fleetAuthBackupScheduler?.start();
  // Companion event relay (w9hj.1): fan-out hub for redacted operational
  // events. Approval events arrive on the gateway bus from the confirmation
  // queue; tool/artifact events arrive from the agent over
  // `companion.event.publish` and are re-published on the same bus.
  const companionRelay = new CompanionEventRelay({
    eventBus,
    approvalBindingOf: (approvalId) => gateway.approvalOwnerOfConfirmation(approvalId),
    ...(config.companionId ? { defaultCompanionId: config.companionId } : {}),
    ...(config.companionFleet
      ? {
        previewRootByCompanionId: Object.fromEntries(config.companionFleet.companions.map(companion => [
          companion.companionId,
          resolvePersonalImagesDir(companion.personalWorkspacePath),
        ])),
      }
      : { previewRoots: [resolvePersonalImagesDir(bootstrap.workspaceRoot)] }),
  });

  const apiServer = await startOptionalGatewayApiServer({
    apiHost,
    apiPort,
    adminHost,
    adminPort,
    config,
    env: process.env,
    eligibilityGate,
    gateway,
    multiCompanion: bootstrap.server.multiCompanion.enabled,
    channelsConfig: bootstrap.channelsConfig,
    fleetPortalChannelHealth,
    satelliteRegistryProvider: () => loadSatelliteRegistryConfig(
      startupHydration.pathSnapshot.systemDataDir,
    ),
    // htm9.9: voice transcripts are screened as 'audio_transcript' intake.
    intakeScreeningMode: privilegedCore.intakeScreening.mode,
    intakeScreening: bootstrap.server.multiCompanion.enabled
      ? null
      : privilegedCore.intakeScreening.screeningFor(),
    ...(bootstrap.server.multiCompanion.enabled
      ? {
          intakeScreeningForCompanion: (companionId: string) =>
            privilegedCore.intakeScreening.screeningFor(companionId),
        }
      : {}),
    companionRelay: {
      relay: companionRelay,
      approvals: {
        resolve: (params) => gateway.resolveCompanionApproval(params),
        findHistory: (id) => gateway.findConfirmationHistoryEntry(id),
        ownerOf: (id) => gateway.ownerOfConfirmation(id),
      },
      audit: (entry) => gateway.recordCompanionAuditSummary(entry),
    },
    ...(privilegedServices.modelUsageStore
      ? { fleetModelUsage: privilegedServices.modelUsageStore }
      : {}),
    ...(fleetAuthPersistence
      ? {
          fleetAuthBroker: fleetAuthPersistence.broker,
          fleetAuthEscalation: fleetAuthPersistence.escalation,
          fleetAuthTrustedHostRecovery: fleetAuthPersistence.trustedHostRecovery,
          ...(fleetAuthLifecycleCeremonies ? { fleetAuthLifecycleCeremonies } : {}),
          fleetAuthChildAssertions: fleetAuthPersistence.childAssertions,
          fleetAuthRequestCapabilities: fleetAuthPersistence.requestCapabilities,
          fleetAuthRequestCapabilityVerifier: fleetAuthPersistence.requestCapabilityVerifier,
          fleetAuthRequestCapabilityReplay: fleetAuthPersistence.requestCapabilityReplay,
          fleetAuthTestingHarnessGardenAuthorizationAudit:
            fleetAuthPersistence.testingHarnessGardenAuthorizationAudit,
          fleetPortalAuthorization: fleetAuthPersistence.portalAuthorization,
          primaryEmbodiments: fleetAuthPersistence.primaryEmbodiments,
          hubDeviceAssertionVerifier: fleetAuthPersistence,
        }
      : {}),
  });
  await voiceSurfaces.start();
  await startGatewayChannelSurfaces(channelSurfaces, bootstrap, log);

  log.info(`Ready — gateway RPC listening on ${formatGatewayRpcEndpoint(bootstrap.gatewayRpcEndpoint)}`);
  log.info(`Workspace: ${bootstrap.workspaceRoot}`);

  // ── Graceful shutdown ──

  let stopPromise: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    if (stopPromise) {
      await stopPromise;
      return;
    }

    stopPromise = (async () => {
      await runShutdownSequence([
        { step: 'stop debug observer', action: () => stopDebugObserver() },
        ...(fleetAuthBackupScheduler
          ? [{
            step: 'stop fleet auth backup scheduler',
            action: async () => { await fleetAuthBackupScheduler.stop(); },
          }]
          : []),
        { step: 'stop turn performance forwarder', action: () => detachTurnPerformanceForwarder() },
        { step: 'stop companion event relay', action: () => companionRelay.stop() },
        { step: 'stop public api server', action: () => apiServer?.stop() },
        { step: 'stop voice surfaces', action: () => voiceSurfaces.stop() },
        { step: 'stop gateway server', action: () => gateway.stop() },
        { step: 'close welfare grant verifier', action: async () => { await welfareGrantVerifier?.close(); } },
        { step: 'close companion presence reader', action: async () => { await companionPresenceStore?.close(); } },
        { step: 'close ICP autonomy store', action: async () => { await icpAutonomyStore?.close(); } },
        { step: 'close ICP fatigue regulation store', action: async () => { await icpFatigueRegulationStore?.close(); } },
        { step: 'close ICP initiation policy authority', action: async () => { await icpInitiationPolicyAuthority?.close(); } },
        { step: 'close fleet auth persistence', action: async () => { await fleetAuthPersistence?.close(); } },
        { step: 'stop channel adapters', action: () => stopGatewayChannelSurfaces(channelSurfaces) },
        { step: 'dispose intake screening', action: () => privilegedCore.intakeScreening.dispose() },
      ], log);
      log.info('Stopped');
    })();

    await stopPromise;
  };

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stop,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: bootstrap.shutdownForceExitTimeoutMs,
  });

  installSignalHandlers(shutdown, log);

  registerProcessErrorHandlers({
    logger: log,
    backgroundFailureEscalationThreshold: config.backgroundFailureEscalationThreshold,
    requestShutdown: () => {
      void shutdown('uncaughtException').catch(() => process.exit(1));
    },
  });
}

// Serialize SubstrateMessage for JSON transport (Date → ISO string)
function serializeMessage(msg: SubstrateMessage): Record<string, unknown> {
  return {
    ...msg,
    timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
  };
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
