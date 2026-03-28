// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npm run gateway

import 'dotenv/config';
import { ensureActiveTimezone } from './shared/time/active-timezone.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './types.js';
import { createComponentLogger } from './logger.js';
import type { EventBus } from './shared/event-bus.js';
import { ensureRegistryFile } from './modules/registry.js';
import { attachTerminalDebugObserver } from './debug/terminal-observer.js';
import type { SubstrateMessage } from './types.js';
import type { EligibilityDecision } from './system/capabilities/eligibility.js';
import { resolveGatewayBootstrapInput } from './gateway/bootstrap-input.js';
import type { StartupConfigHydrationDiagnostics } from './runtime/bootstrap-helpers.js';
import { RUNTIME_MODE } from './system/lifecycle/runtime-mode.js';
import { applyGatewayTlsConfig } from './gateway/tls.js';
import { buildGatewayPrivilegedCore } from './gateway/privileged-core.js';
import {
  initGatewayChannelSurfaces,
  loadGatewayChannelSurfaces,
  startGatewayChannelSurfaces,
  stopGatewayChannelSurfaces,
  wireGatewayChannelMessages,
} from './gateway/channel-surfaces.js';
import { createGatewayVoiceSurfaces } from './gateway/voice-surfaces.js';
import { resolveStartupPreflightBundle } from './runtime/startup-preflight.js';
import { runShutdownSequence } from './runtime/shutdown-helpers.js';
import { createSignalShutdownHandler } from './runtime/signal-shutdown.js';

const log = createComponentLogger('Gateway');

ensureActiveTimezone();

function logStartupHydrationDiagnostics(diagnostics: StartupConfigHydrationDiagnostics): void {
  if (diagnostics.modelsMigratedFromLegacySettings) {
    log.warn('Migrated legacy model settings from settings.json to models.json');
  } else if (diagnostics.modelsLegacyDriftDetected) {
    log.warn('Detected legacy model drift between settings.json and models.json; models.json is authoritative');
  }
  if (diagnostics.providersMigratedFromLegacyConfig) {
    log.warn('Migrated legacy provider endpoints into providers.json');
  } else if (diagnostics.providersLegacyDriftDetected) {
    log.warn('Detected provider endpoint drift between legacy config and providers.json; providers.json is authoritative');
  }

  if (diagnostics.maintenanceIntervalMigration.state === 'migrated') {
    log.warn('Migrated legacy maintenanceIntervalMs from settings.json to scheduler.json', {
      maintenanceIntervalMs:
        diagnostics.maintenanceIntervalMigration.storedValue
        ?? diagnostics.maintenanceIntervalMigration.settingsValue,
    });
  } else if (diagnostics.maintenanceIntervalMigration.state === 'drift_detected') {
    log.warn('Detected scheduler drift between settings.json and scheduler.json; scheduler.json is authoritative', {
      settingsMaintenanceIntervalMs: diagnostics.maintenanceIntervalMigration.settingsValue,
      schedulerMaintenanceIntervalMs: diagnostics.maintenanceIntervalMigration.storedValue,
    });
  } else if (diagnostics.maintenanceIntervalMigration.state === 'error') {
    log.warn('Failed to migrate legacy maintenanceIntervalMs from settings.json', {
      error: diagnostics.maintenanceIntervalMigration.error ?? 'unknown',
    });
  }

  if (diagnostics.capabilityTierMigration.state === 'migrated') {
    log.warn('Migrated legacy capabilityTier from settings.json to capability-tier.json', {
      capabilityTier:
        diagnostics.capabilityTierMigration.storedValue
        ?? diagnostics.capabilityTierMigration.settingsValue,
    });
  } else if (diagnostics.capabilityTierMigration.state === 'drift_detected') {
    log.warn('Detected capability tier drift between settings.json and capability-tier.json; capability-tier.json is authoritative', {
      settingsCapabilityTier: diagnostics.capabilityTierMigration.settingsValue,
      capabilityTier: diagnostics.capabilityTierMigration.storedValue,
    });
  } else if (diagnostics.capabilityTierMigration.state === 'error') {
    log.warn('Failed to migrate legacy capabilityTier from settings.json', {
      error: diagnostics.capabilityTierMigration.error ?? 'unknown',
    });
  }

  if (diagnostics.removedLegacyKeys.length > 0) {
    if (diagnostics.settingsRewriteError) {
      log.warn('Failed to rewrite settings.json without legacy cross-domain keys', {
        keys: diagnostics.removedLegacyKeys,
        error: diagnostics.settingsRewriteError,
      });
    } else {
      log.warn('Removed legacy cross-domain keys from settings.json', {
        keys: diagnostics.removedLegacyKeys,
      });
    }
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
  const {
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env,
    logger: log,
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
  if (!bootstrap.diagnostics.workspacePathProvided) {
    log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      workspacePath: bootstrap.workspacePath,
    });
  }
  // ── Apply TLS config early, before any HTTPS connections ──
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });

  const privilegedCore = buildGatewayPrivilegedCore({
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
    auditDb,
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

  // Ensure gateway socket directory exists
  mkdirSync(dirname(bootstrap.socketPath), { recursive: true });
  mkdirSync(bootstrap.workspaceRoot, { recursive: true });
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
    log,
  });
  log.info('Embedding provider initialized', {
    provider: privilegedServices.embeddingProvider.kind,
    dims: privilegedServices.embeddingProvider.dims,
  });
  const { discord, telegram } = channelSurfaces;

  log.info(`Audit log: ${bootstrap.auditDbPath}`);

  // ── Create gateway server ──

  const gateway = createGatewayServer({ discordAdapter: discord });
  const voiceSurfaces = await createGatewayVoiceSurfaces({
    config,
    eventBus,
    gateway,
    discord,
    eligibilityGate,
    log,
  });
  wireGatewayChannelMessages({
    discord,
    telegram,
    gateway,
    serializeMessage,
  });

  // ── Start everything ──

  await initGatewayChannelSurfaces(channelSurfaces);
  gateway.start();
  await voiceSurfaces.start();
  await startGatewayChannelSurfaces(channelSurfaces, bootstrap, log);

  log.info(`Ready — listening on ${bootstrap.socketPath}`);
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
        { step: 'stop voice surfaces', action: () => voiceSurfaces.stop() },
        { step: 'stop gateway server', action: () => gateway.stop() },
        { step: 'stop channel adapters', action: () => stopGatewayChannelSurfaces(channelSurfaces) },
        {
          step: 'close audit database',
          action: () => {
            auditDb.close();
          },
        },
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
