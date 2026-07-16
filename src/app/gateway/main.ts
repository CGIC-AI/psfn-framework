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
import { createSignalShutdownHandler, registerProcessErrorHandlers } from '../startup/support/signal-shutdown.js';
import { resolveGatewayApiSurfaceBindings, startOptionalGatewayApiServer } from './api-surface.js';
import { startOptionalFleetStatusServer } from '../../boundary/gateway/fleet-status.js';
import { loadSatelliteRegistryConfig } from '../../channels/backplane/satellite-registry.js';
import { assertSatellitePlaceBindings, loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import { GatewayCompanionChannelLane } from '../../boundary/gateway/companion-channels.js';
import { PostgresCompanionPresenceStore } from '../../persistence/postgres/companion-presence-store.js';
import { PostgresIcpSharedAutonomyStore } from '../../persistence/postgres/icp-shared-autonomy-store.js';
import { PostgresIcpInitiationPolicyAuthority } from '../../persistence/postgres/icp-initiation-policy-authority.js';
import { PostgresIcpFatigueRegulationReservationStore } from '../../persistence/postgres/icp-fatigue-regulation-reservation-store.js';
import { IcpFatigueInitiationCapacityAuthority } from '../../core/agent/fatigue/initiation-capacity.js';
import { readRunChargeRollingWindowFromLedger } from '../../shared/telemetry/charge-ledger.js';
import { RootBoundIcpInitiationCausalityAuthority } from '../../boundary/gateway/icp-initiation-causality-authority.js';
import { CompanionEventRelay } from '../../channels/backplane/companion-relay/relay.js';
import { CHARGE_POLICY_FILE_NAME } from '../../system/config/charge-policy-config.js';
import {
  ensurePersonalFilesLayout,
  resolveCogSecEventsPath,
  resolveContactBlockListPath,
  resolveChargeLedgerPath,
  resolvePersonalImagesDir,
} from '../../persistence/layout.js';
import { provisionFleetWorkspaces } from '../../persistence/workspaces/provisioning.js';
import { migrateLegacyWorkspaceForFleet } from '../../persistence/workspaces/legacy-workspace-migration.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { createGatewayContactBlockGate } from '../../boundary/gateway/contact-block-gate.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { attachGatewayTurnPerformanceForwarder } from '../../boundary/gateway/turn-performance-forwarder.js';
import { initializeGatewayFleetAuthPersistence } from '../../persistence/postgres/fleet-auth/gateway-persistence.js';
import { assertFleetAuthLegacySurfacesUnavailable } from '../../system/config/fleet-auth-legacy-surface-guard.js';
import { resolveGatewayFleetAuthSecrets } from '../../system/config/fleet-auth-config.js';
import { resolveBackupRuntimeConfig } from '../../persistence/backups/config.js';
import { resolveKubernetesHelmBackupConfig } from '../../persistence/backups/kubernetes-helm.js';
import { deriveRestoreVerifyDatabaseUrl } from '../../persistence/backups/postgres-restore.js';
import { migrateFleetAuthSchema } from '../../persistence/postgres/fleet-auth/schema.js';
import { buildFleetAuthBackupCycleOptions } from '../../persistence/backups/fleet-scheduler.js';
import { resolveFleetAuthSchemaAccessContracts } from '../../persistence/backups/fleet-auth-schema-access.js';
import {
  DEFAULT_SHARED_WORLD_SCHEMA,
  registerScheduledFleetAuthBackupTask,
  SCHEDULED_BACKUP_TASK_ID,
  SCHEDULED_BACKUP_TASK_NAME,
} from '../../persistence/backups/service.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';

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
  assertFleetAuthLegacySurfacesUnavailable({
    fleetAuthEnabled: config.fleetAuth !== undefined,
    processMode: 'gateway',
    env,
    principalAuthenticationWired: false,
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
  const fleetAuthPersistence = await initializeGatewayFleetAuthPersistence({
    config: config.fleetAuth,
    credentialVault: config.credentialVault,
    ...(config.postgresDatabaseUrl
      ? { companionDatabaseUrl: config.postgresDatabaseUrl }
      : {}),
    protectedRestoreRoots: fleetAuthProtectedRestoreRoots,
    lifecycleWitnessRoot: startupHydration.pathSnapshot.systemDataDir,
  });
  if (config.fleetAuth && !config.companionFleet) {
    throw new Error(
      'Fleet auth is enabled but the resolved config carries no companion fleet — refusing to start without a complete gateway-owned backup family',
    );
  }
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
    sourcePath: `${startupHydration.pathSnapshot.systemDataDir}/${CHARGE_POLICY_FILE_NAME}`,
  });
  if (!bootstrap.diagnostics.workspacePathProvided) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      workspacePath: bootstrap.workspacePath,
    });
  }

  const privilegedCore = await buildGatewayPrivilegedCore({
    config,
    env,
    bootstrap,
    startupHydration,
    logger: log,
    onEligibilityDecision: emitEligibilityDecision,
  });
  const {
    eventBus,
    eligibilityGate,
    privilegedServices,
    createGatewayServer,
  } = privilegedCore;
  let fleetAuthBackupScheduler: Scheduler | undefined;
  if (config.fleetAuth) {
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
    const fleetAuthSecrets = resolveGatewayFleetAuthSecrets({
      config: config.fleetAuth,
      credentialVault: config.credentialVault,
      protectedRestoreRoots: fleetAuthProtectedRestoreRoots,
      ...(config.postgresDatabaseUrl
        ? { companionDatabaseUrl: config.postgresDatabaseUrl }
        : {}),
    });
    if (backupConfig.verifyRestore) {
      const scratchMigrationUrl = deriveRestoreVerifyDatabaseUrl(
        fleetAuthSecrets.database.migrationUrl,
      );
      if (!scratchMigrationUrl) {
        throw new Error(
          'Fleet auth verifyRestore requires a derivable migration URL for the dedicated scratch database',
        );
      }
      // The scratch database itself remains an operator-provisioned recovery
      // target. Gateway startup idempotently provisions only its fleet_auth
      // schema with the migration authority; backup cycles still use only the
      // dedicated backup/restore credential.
      await migrateFleetAuthSchema({
        databaseUrl: scratchMigrationUrl,
        roles: config.fleetAuth.databaseRoles,
      });
    }
    const kubernetesHelm = resolveKubernetesHelmBackupConfig(env);
    const schemaAccessContracts = await resolveFleetAuthSchemaAccessContracts({
      databaseUrl: fleetAuthSecrets.database.backupRestoreUrl,
      companionSchemas: config.companionFleet.companions.map(companion => companion.postgresSchema),
      sharedSchema: DEFAULT_SHARED_WORLD_SCHEMA,
      roles: config.fleetAuth.databaseRoles,
    });
    const cycleOptions = buildFleetAuthBackupCycleOptions({
      fleet: config.companionFleet,
      systemDataDir: startupHydration.pathSnapshot.systemDataDir,
      backupRestoreDatabaseUrl: fleetAuthSecrets.database.backupRestoreUrl,
      roles: config.fleetAuth.databaseRoles,
      authorityFloors: fleetAuthPersistence.authorityFloors,
      schemaAccessContracts,
      backupConfig,
      ...(kubernetesHelm ? { kubernetesHelm } : {}),
    });
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
      onBackupFailure: (error) => {
        void eventBus.emit('backup.failed', {
          taskId: SCHEDULED_BACKUP_TASK_ID,
          taskName: SCHEDULED_BACKUP_TASK_NAME,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      },
    });
    fleetAuthBackupScheduler.start();
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
    migrateLegacyWorkspaceForFleet({
      fleet: config.companionFleet,
      legacyWorkspacePath: process.env.WORKSPACE_PATH,
      env: process.env,
    });
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
    intakeScreening: privilegedCore.intakeScreening.screening,
    log,
  });
  log.info('Embedding provider initialized', {
    provider: privilegedServices.embeddingProvider.kind,
    dims: privilegedServices.embeddingProvider.dims,
  });
  const { discord, telegram } = channelSurfaces;

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
  let icpInitiationPolicyAuthority: PostgresIcpInitiationPolicyAuthority | null = null;
  let companionChannelLane: GatewayCompanionChannelLane | undefined;
  if (config.multiCompanion === true) {
    const databaseUrl = config.postgresDatabaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error('Multi-companion inter-companion channels require config.postgresDatabaseUrl');
    }
    if (!config.companionFleet) {
      throw new Error('Multi-companion inter-companion channels require the companions.json fleet manifest');
    }
    const fleetCompanionIds = config.companionFleet.companions.map((entry) => entry.companionId);
    const fleetByCompanionId = new Map(
      config.companionFleet.companions.map(entry => [entry.companionId, entry]),
    );
    companionPresenceStore = await PostgresCompanionPresenceStore.connect(databaseUrl);
    icpAutonomyStore = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: fleetCompanionIds,
    });
    icpFatigueRegulationStore =
      await PostgresIcpFatigueRegulationReservationStore.connect(databaseUrl);
    icpInitiationPolicyAuthority = new PostgresIcpInitiationPolicyAuthority(databaseUrl, {
      fleet: config.companionFleet.companions,
      quietHours: startupHydration.schedulerConfig.episodicProcessing,
      capacityAuthority: new IcpFatigueInitiationCapacityAuthority(
        icpFatigueRegulationStore,
        startupHydration.chargePolicyConfig,
        {
          read: ({ senderCompanionId, nowMs }) => {
            const fleetEntry = fleetByCompanionId.get(createCompanionId(
              senderCompanionId,
              'ICP social charge balance senderCompanionId',
            ));
            if (!fleetEntry) {
              throw new Error('ICP social charge balance requires a known fleet sender');
            }
            return readRunChargeRollingWindowFromLedger(
              resolveChargeLedgerPath(fleetEntry.companionDataDir),
              nowMs,
            );
          },
        },
      ),
      causalityAuthority: new RootBoundIcpInitiationCausalityAuthority(),
    });
    companionChannelLane = new GatewayCompanionChannelLane({
      placesRegistry: placesRegistryConfig,
      presence: companionPresenceStore,
      fleetCompanionIds: new Set(fleetCompanionIds),
    });
    log.info('Inter-companion channel lane enabled', {
      fleetSize: config.companionFleet.companions.length,
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
    welfareGrantVerifier = createWelfareGrantVerifier({
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
  }

  const gateway = createGatewayServer({
    discordAdapter: discord,
    ...(discordAccountDocks ? { discordAccountDocks } : {}),
    ...(companionChannelLane ? { companionChannels: companionChannelLane } : {}),
    ...(icpAutonomyStore ? { icpAutonomyStore } : {}),
    ...(icpInitiationPolicyAuthority ? { icpInitiationPolicyAuthority } : {}),
    ...(welfareGrantVerifier ? { welfareGrantVerifier } : {}),
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
  gateway.start();
  // Fleet-status surface (sprint-10 W4): config-gated, read-only cluster
  // health view over the connection registry. Absent FLEET_STATUS_PORT keeps
  // single-companion behavior byte-identical.
  const fleetStatusServer = await startOptionalFleetStatusServer({
    env: process.env,
    multiCompanion: config.multiCompanion === true,
    ...(config.companionFleet ? { fleet: config.companionFleet.companions } : {}),
    source: gateway,
  });

  // Companion event relay (w9hj.1): fan-out hub for redacted operational
  // events. Approval events arrive on the gateway bus from the confirmation
  // queue; tool/artifact events arrive from the agent over
  // `companion.event.publish` and are re-published on the same bus.
  const companionRelay = new CompanionEventRelay({
    eventBus,
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
    channelsConfig: bootstrap.channelsConfig,
    satelliteRegistryProvider: () => loadSatelliteRegistryConfig(
      startupHydration.pathSnapshot.systemDataDir,
    ),
    // htm9.9: voice transcripts are screened as 'audio_transcript' intake.
    intakeScreening: privilegedCore.intakeScreening.screening,
    companionRelay: {
      relay: companionRelay,
      approvals: {
        resolve: (params) => gateway.resolveCompanionApproval(params),
        findHistory: (id) => gateway.findConfirmationHistoryEntry(id),
      },
      audit: (entry) => gateway.recordCompanionAuditSummary(entry),
    },
    ...(fleetAuthPersistence ? { fleetAuthBroker: fleetAuthPersistence.broker } : {}),
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
        { step: 'stop fleet status server', action: () => fleetStatusServer?.stop() },
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

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });

  registerProcessErrorHandlers({
    logger: log,
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
