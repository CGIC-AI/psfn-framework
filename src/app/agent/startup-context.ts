import { loadConfig } from '../../system/config/load-config.js';
import { EventBus } from '../../shared/event-bus.js';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import { resolveBackupRuntimeConfig } from '../../persistence/backups/config.js';
import {
  RUNTIME_MODE,
} from '../../system/lifecycle/runtime-mode.js';
import { attachTerminalDebugObserver } from '../startup/support/terminal-observer.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import {
  createEligibilityGate,
  type EligibilityGate,
} from '../../system/capabilities/eligibility.js';
import {
  ensureRegistryFile,
  resolveModuleRegistryPathFromWorkspace,
} from '../../system/modules/registry.js';
import {
  loadRuntimeChannelsConfig,
} from '../../channels/backplane/config.js';
import {
  buildRuntimeChannelsConfigOverrides,
} from '../startup/support/bootstrap-helpers.js';
import { resolveStartupPreflightBundle } from '../startup/support/startup-preflight.js';
import { emitEligibilityDecisionTelemetry } from '../startup/support/eligibility-telemetry.js';
import {
  sanitizeCoreSubstrateConfig,
  type CoreSubstrateConfig,
  type SubstrateConfig,
} from '../../system/config/runtime-config-contracts.js';
import type { StartupHydrationLegacyMigrationDiagnostics } from '../startup/support/bootstrap-helpers.js';
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';

interface AgentStartupLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentStartupHydrationDiagnostics {
  modelsMigratedFromLegacySettings: boolean;
  modelsLegacyDriftDetected: boolean;
  providersMigratedFromLegacyConfig: boolean;
  providersLegacyDriftDetected: boolean;
  maintenanceIntervalMigration: StartupHydrationLegacyMigrationDiagnostics;
  capabilityTierMigration: StartupHydrationLegacyMigrationDiagnostics;
  removedLegacyKeys: string[];
  settingsRewriteError?: string;
}

export interface AgentStartupContext {
  config: SubstrateConfig;
  coreConfig: CoreSubstrateConfig;
  lifecycleRuntimeContract: ReturnType<typeof resolveStartupPreflightBundle>['lifecycleRuntimeContract'];
  runtimeStatusMeta: ReturnType<typeof resolveStartupPreflightBundle>['runtimeStatusMeta'];
  startupHydration: ReturnType<typeof resolveStartupPreflightBundle>['startupHydration'];
  pathSnapshot: RuntimePathSnapshot;
  schedulerConfig: ReturnType<typeof resolveStartupPreflightBundle>['startupHydration']['schedulerConfig'];
  trustPolicyConfig: ReturnType<typeof resolveStartupPreflightBundle>['startupHydration']['trustPolicyConfig'];
  channelsConfig: RuntimeChannelsConfig;
  backupConfig: ReturnType<typeof resolveBackupRuntimeConfig>;
  capabilityRuntime: CapabilityRuntime;
  eligibilityGate: EligibilityGate;
  socketPath: string;
  moduleRegistryPath: string;
  eventBus: EventBus;
  stopDebugObserver: () => void;
}

export function logAgentStartupHydrationDiagnostics(
  log: AgentStartupLogger,
  diagnostics: AgentStartupHydrationDiagnostics,
): void {
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

export function prepareAgentStartupContext(input: {
  env: NodeJS.ProcessEnv;
  log: AgentStartupLogger;
}): AgentStartupContext {
  const config = loadConfig();
  const coreConfig = sanitizeCoreSubstrateConfig(config);
  const {
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env: input.env,
    logger: input.log,
  });
  logAgentStartupHydrationDiagnostics(input.log, startupHydration.diagnostics);

  const { pathSnapshot, trustPolicyConfig, schedulerConfig } = startupHydration;
  input.log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  const channelsConfig = loadRuntimeChannelsConfig(
    pathSnapshot.systemDataDir,
    input.env,
    buildRuntimeChannelsConfigOverrides(config, startupHydration.settingsDomains.runtime),
    { credentialVault: config.credentialVault },
  );
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: pathSnapshot.companionDataDir,
    defaultRootDir: pathSnapshot.runtimePathLayout.backupsDir,
  });
  const eventBus = new EventBus();
  const capabilityRuntime = new CapabilityRuntime({
    dataDir: pathSnapshot.systemDataDir,
    seedDir: input.env.CONFIG_DIR,
  });
  config.capabilityTier = capabilityRuntime.getTier();
  const eligibilityGate = createEligibilityGate(
    () => capabilityRuntime,
    (decision) => emitEligibilityDecisionTelemetry(eventBus, decision, input.log),
  );
  const socketPath = input.env.GATEWAY_SOCKET ?? DEFAULT_GATEWAY_SOCKET_PATH;
  if (!input.env.WORKSPACE_PATH) {
    input.log.warn('WORKSPACE_PATH not set, defaulting to runtime layout workspace path', {
      mode: pathSnapshot.runtimePathLayout.mode,
      workspacePath: pathSnapshot.workspacePath,
      resolved: pathSnapshot.workspaceRoot,
    });
  }
  const moduleRegistryPath = resolveModuleRegistryPathFromWorkspace(
    pathSnapshot.workspaceRoot,
    input.env.MODULE_REGISTRY_PATH,
  );
  ensureRegistryFile(moduleRegistryPath);
  const stopDebugObserver = attachTerminalDebugObserver(eventBus, { scope: 'agent' });

  return {
    config,
    coreConfig,
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    startupHydration,
    pathSnapshot,
    schedulerConfig,
    trustPolicyConfig,
    channelsConfig,
    backupConfig,
    capabilityRuntime,
    eligibilityGate,
    socketPath,
    moduleRegistryPath,
    eventBus,
    stopDebugObserver,
  };
}
