import { loadAgentConfig } from '../../system/config/load-config.js';
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
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';

interface AgentStartupLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentStartupHydrationDiagnostics {
  legacySettingsKeys: string[];
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
  if (diagnostics.legacySettingsKeys.length > 0) {
    log.error('Startup rejected cross-domain keys in settings.json', {
      keys: diagnostics.legacySettingsKeys,
    });
  }
}

export function prepareAgentStartupContext(input: {
  env: NodeJS.ProcessEnv;
  log: AgentStartupLogger;
}): AgentStartupContext {
  const config = loadAgentConfig();
  const {
    lifecycleRuntimeContract,
    runtimeStatusMeta,
    startupHydration,
  } = resolveStartupPreflightBundle(config, {
    entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
    env: input.env,
    secretAuthority: 'agent',
    logger: input.log,
  });
  const coreConfig = sanitizeCoreSubstrateConfig(config);
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
  const runtimeChannelsOverrides = buildRuntimeChannelsConfigOverrides(
    config,
    startupHydration.settingsDomains.runtime,
  );
  const channelsConfig = loadRuntimeChannelsConfig(
    pathSnapshot.systemDataDir,
    {},
    {
      ...runtimeChannelsOverrides,
      telegram: {
        ...runtimeChannelsOverrides.telegram,
        enabled: false,
      },
    },
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
