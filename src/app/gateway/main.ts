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
import { CHARGE_POLICY_FILE_NAME } from '../../system/config/charge-policy-config.js';
import {
  ensurePersonalFilesLayout,
  resolveCogSecEventsPath,
  resolveContactBlockListPath,
} from '../../persistence/layout.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { createGatewayContactBlockGate } from '../../boundary/gateway/contact-block-gate.js';

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
  ensurePersonalFilesLayout(bootstrap.workspaceRoot);
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
  let companionChannelLane: GatewayCompanionChannelLane | undefined;
  if (config.multiCompanion === true) {
    const databaseUrl = config.postgresDatabaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error('Multi-companion inter-companion channels require config.postgresDatabaseUrl');
    }
    if (!config.companionFleet) {
      throw new Error('Multi-companion inter-companion channels require the companions.json fleet manifest');
    }
    companionPresenceStore = await PostgresCompanionPresenceStore.connect(databaseUrl);
    companionChannelLane = new GatewayCompanionChannelLane({
      placesRegistry: placesRegistryConfig,
      presence: companionPresenceStore,
      fleetCompanionIds: new Set(config.companionFleet.companions.map((entry) => entry.companionId)),
    });
    log.info('Inter-companion channel lane enabled', {
      fleetSize: config.companionFleet.companions.length,
      placeCount: placesRegistryConfig.places.length,
    });
  }

  const gateway = createGatewayServer({
    discordAdapter: discord,
    ...(discordAccountDocks ? { discordAccountDocks } : {}),
    ...(companionChannelLane ? { companionChannels: companionChannelLane } : {}),
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
    satelliteRegistry: satelliteRegistryConfig,
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
        { step: 'stop fleet status server', action: () => fleetStatusServer?.stop() },
        { step: 'stop public api server', action: () => apiServer?.stop() },
        { step: 'stop voice surfaces', action: () => voiceSurfaces.stop() },
        { step: 'stop gateway server', action: () => gateway.stop() },
        { step: 'close companion presence reader', action: async () => { await companionPresenceStore?.close(); } },
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
