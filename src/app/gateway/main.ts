// ── Gateway Entry Point ──
// Host-side process that holds secrets and proxies all external interactions.
// Run: npx tsx src/app/gateway/main.ts

import 'dotenv/config';
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
import { createSignalShutdownHandler } from '../startup/support/signal-shutdown.js';
import { resolveGatewayApiSurfaceBindings, startOptionalGatewayApiServer } from './api-surface.js';

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

  if ((config.persistenceBackend ?? 'sqlite') === 'sqlite') {
    log.info(`Audit log: ${bootstrap.auditDbPath}`);
  } else {
    log.info('Gateway audit persistence backend', {
      persistenceBackend: config.persistenceBackend ?? 'sqlite',
    });
  }

  // ── Create gateway server ──

  const gateway = createGatewayServer({ discordAdapter: discord });
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
  wireGatewayChannelMessages({
    discord,
    telegram,
    gateway,
    serializeMessage,
  });

  // ── Start everything ──

  await initGatewayChannelSurfaces(channelSurfaces);
  gateway.start();
  const apiServer = await startOptionalGatewayApiServer({
    apiHost,
    apiPort,
    adminHost,
    adminPort,
    config,
    env: process.env,
    eligibilityGate,
    gateway,
  });
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
        { step: 'stop public api server', action: () => apiServer?.stop() },
        { step: 'stop voice surfaces', action: () => voiceSurfaces.stop() },
        { step: 'stop gateway server', action: () => gateway.stop() },
        { step: 'stop channel adapters', action: () => stopGatewayChannelSurfaces(channelSurfaces) },
        {
          step: 'close audit database',
          action: () => {
            auditDb?.close();
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
