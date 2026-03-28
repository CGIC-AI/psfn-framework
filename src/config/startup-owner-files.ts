import type { EditableSettings, SettingsDomainSplit } from '../settings.js';
import { splitSettingsByDomain, loadSettings } from '../settings.js';
import {
  loadModelsConfigWithLegacyMigration,
  type ModelsLoadResult,
} from './models-config.js';
import {
  loadProvidersConfigWithLegacyMigration,
  type ProvidersLoadResult,
} from './providers-config.js';
import {
  loadTrustPolicyConfig,
  type TrustPolicyConfig,
} from './trust-policy-config.js';
import {
  loadSchedulerConfig,
  type SchedulerRuntimeConfig,
} from './scheduler-config.js';
import {
  loadCapabilityTierConfig,
  type CapabilityTierConfig,
} from './capability-tier-config.js';

export interface StartupOwnerFileLoadOptions {
  dataDir: string;
  seedDir?: string;
  defaultContextWindow?: number;
  legacyLiteLLMBaseUrl?: string;
  legacyOpenRouterModelsApiUrl?: string;
}

export interface StartupOwnerFileState {
  runtimeSettings: EditableSettings;
  settingsDomains: SettingsDomainSplit;
  modelsLoadResult: ModelsLoadResult;
  providersLoadResult: ProvidersLoadResult;
  trustPolicyConfig: TrustPolicyConfig;
}

export function loadStartupRuntimeSettingsOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir'>,
): Pick<StartupOwnerFileState, 'runtimeSettings' | 'settingsDomains'> {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const runtimeSettings = loadSettings(options.dataDir, loadOptions);
  const settingsDomains = splitSettingsByDomain(runtimeSettings);
  return {
    runtimeSettings,
    settingsDomains,
  };
}

export function loadStartupModelsOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir' | 'defaultContextWindow'> & {
    legacySettings?: EditableSettings;
  },
): ModelsLoadResult {
  const modelsLoadResult = loadModelsConfigWithLegacyMigration(options.dataDir, {
    defaultContextWindow: options.defaultContextWindow,
    legacySettings: options.legacySettings,
  });
  return modelsLoadResult;
}

export function loadStartupProvidersOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir' | 'legacyLiteLLMBaseUrl' | 'legacyOpenRouterModelsApiUrl'>,
): ProvidersLoadResult {
  const providersLoadResult = loadProvidersConfigWithLegacyMigration(options.dataDir, {
    seedDir: options.seedDir,
    legacyLiteLLMBaseUrl: options.legacyLiteLLMBaseUrl,
    legacyOpenRouterModelsApiUrl: options.legacyOpenRouterModelsApiUrl,
  });
  return providersLoadResult;
}

export function loadStartupTrustPolicyOwnerFile(
  dataDir: string,
  seedDir?: string,
): TrustPolicyConfig {
  return loadTrustPolicyConfig(dataDir, seedDir ? { seedDir } : undefined);
}

export function loadStartupSchedulerOwnerFile(
  dataDir: string,
  seedDir?: string,
): SchedulerRuntimeConfig {
  return loadSchedulerConfig(dataDir, seedDir ? { seedDir } : undefined);
}

export function loadStartupCapabilityTierOwnerFile(
  dataDir: string,
  seedDir?: string,
): CapabilityTierConfig {
  return loadCapabilityTierConfig(dataDir, seedDir ? { seedDir } : undefined);
}
