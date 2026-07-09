import { loadAgentConfig } from '../../system/config/load-config.js';
import { EventBus } from '../../shared/event-bus.js';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import {
  resolveGatewayRpcEndpointFromEnv,
  type GatewayRpcEndpoint,
} from '../../boundary/gateway/transport.js';
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
  loadSatelliteRegistryConfig,
} from '../../channels/backplane/satellite-registry.js';
import {
  assertSatellitePlaceBindings,
  loadPlacesRegistryConfig,
} from '../../channels/backplane/places-registry.js';
import { setRuntimeChannelEnvelopeLabels } from '../../system/trust/runtime-channel-labels.js';
import { CHARGE_POLICY_FILE_NAME } from '../../system/config/charge-policy-config.js';
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
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';

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
  satelliteRegistryConfig: SatelliteRegistryConfig;
  placesRegistryConfig: PlacesRegistryConfig;
  backupConfig: ReturnType<typeof resolveBackupRuntimeConfig>;
  capabilityRuntime: CapabilityRuntime;
  eligibilityGate: EligibilityGate;
  socketPath: string;
  gatewayRpcEndpoint: GatewayRpcEndpoint;
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

  const { pathSnapshot, trustPolicyConfig, schedulerConfig, chargePolicyConfig } = startupHydration;
  input.log.info('Loaded trust policy configuration', {
    exactOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.exact,
    ).length,
    prefixOverrideCount: Object.keys(
      trustPolicyConfig.channelClassification.visibilityOverrides.prefix,
    ).length,
  });
  input.log.info('Loaded charge policy quotas', {
    runChargeQuotaByLane: chargePolicyConfig.runChargeQuotaByLane,
    sourcePath: `${pathSnapshot.systemDataDir}/${CHARGE_POLICY_FILE_NAME}`,
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
  // E3.2: publish channel-owned Context Envelope labels for classification
  // (channel-owned label > operator override > derived default).
  setRuntimeChannelEnvelopeLabels(channelsConfig.contextEnvelope.channels);
  input.log.info('Loaded channel-owned context envelope labels', {
    labeledChannelCount: Object.keys(channelsConfig.contextEnvelope.channels).length,
  });
  const satelliteRegistryConfig = loadSatelliteRegistryConfig(pathSnapshot.systemDataDir);
  const placesRegistryConfig = loadPlacesRegistryConfig(pathSnapshot.systemDataDir);
  assertSatellitePlaceBindings(satelliteRegistryConfig, placesRegistryConfig);
  const backupConfig = resolveBackupRuntimeConfig({
    dataDir: pathSnapshot.systemDataDir,
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
  const gatewayRpcEndpoint = resolveGatewayRpcEndpointFromEnv(input.env, DEFAULT_GATEWAY_SOCKET_PATH);
  const socketPath = gatewayRpcEndpoint.kind === 'unix'
    ? gatewayRpcEndpoint.socketPath
    : input.env.GATEWAY_SOCKET ?? DEFAULT_GATEWAY_SOCKET_PATH;
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
    satelliteRegistryConfig,
    placesRegistryConfig,
    backupConfig,
    capabilityRuntime,
    eligibilityGate,
    socketPath,
    gatewayRpcEndpoint,
    moduleRegistryPath,
    eventBus,
    stopDebugObserver,
  };
}
