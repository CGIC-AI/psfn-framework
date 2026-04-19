import { join } from 'node:path';
import type { EditableSettings, SettingsDomainSplit } from '../settings.js';
import { SETTINGS_FILE_NAME } from '../settings/contracts.js';
import { splitSettingsByDomain, loadSettings } from '../settings.js';
import {
  loadModelsConfigWithLegacyMigration,
  type ModelsLoadResult,
  MODELS_FILE_NAME,
} from './models-config.js';
import {
  loadProvidersConfigWithLegacyMigration,
  type ProvidersLoadResult,
  PROVIDERS_FILE_NAME,
} from './providers-config.js';
import {
  loadTrustPolicyConfig,
  type TrustPolicyConfig,
  TRUST_POLICY_FILE_NAME,
} from './trust-policy-config.js';
import {
  loadSchedulerConfig,
  type SchedulerRuntimeConfig,
  SCHEDULER_FILE_NAME,
} from './scheduler-config.js';
import {
  loadCapabilityTierConfig,
  type CapabilityTierConfig,
  CAPABILITY_TIER_FILE_NAME,
} from './capability-tier-config.js';
import {
  loadChargePolicyConfig,
  type ChargePolicyConfig,
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_SEED_FILE_NAME,
} from './charge-policy-config.js';

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
  chargePolicyConfig: ChargePolicyConfig;
}

export interface StartupOwnerFileVerificationResult {
  ok: boolean;
  errors: string[];
}

function ownerFileSeedDir(options: Pick<StartupOwnerFileLoadOptions, 'seedDir'>): string {
  return options.seedDir ?? process.env.CONFIG_DIR ?? './config';
}

function formatOwnerFileError(input: {
  label: string;
  dataPath: string;
  seedPath: string;
  error: unknown;
}): string {
  const cause = input.error instanceof Error ? input.error.message : String(input.error);
  return `Invalid ${input.label} owner file at ${input.dataPath}. Remove or repair it so it can be reseeded from ${input.seedPath}. Cause: ${cause}`;
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

export function loadStartupChargePolicyOwnerFile(
  dataDir: string,
  seedDir?: string,
): ChargePolicyConfig {
  return loadChargePolicyConfig(dataDir, seedDir ? { seedDir } : undefined);
}

export function verifyStartupOwnerFiles(
  options: StartupOwnerFileLoadOptions,
): StartupOwnerFileVerificationResult {
  const seedDir = ownerFileSeedDir(options);
  const checks: Array<{ label: string; dataPath: string; seedPath: string; run: () => unknown }> = [
    {
      label: 'settings',
      dataPath: join(options.dataDir, SETTINGS_FILE_NAME),
      seedPath: join(seedDir, 'settings.seed.json'),
      run: () => loadStartupRuntimeSettingsOwnerFile({ dataDir: options.dataDir, seedDir: options.seedDir }),
    },
    {
      label: 'models',
      dataPath: join(options.dataDir, MODELS_FILE_NAME),
      seedPath: join(seedDir, 'models.seed.json'),
      run: () => loadStartupModelsOwnerFile({
        dataDir: options.dataDir,
        seedDir: options.seedDir,
        defaultContextWindow: options.defaultContextWindow,
      }),
    },
    {
      label: 'providers',
      dataPath: join(options.dataDir, PROVIDERS_FILE_NAME),
      seedPath: join(seedDir, 'providers.seed.json'),
      run: () => loadStartupProvidersOwnerFile({
        dataDir: options.dataDir,
        seedDir: options.seedDir,
      }),
    },
    {
      label: 'trust-policy',
      dataPath: join(options.dataDir, TRUST_POLICY_FILE_NAME),
      seedPath: join(seedDir, 'trust-policy.seed.json'),
      run: () => loadStartupTrustPolicyOwnerFile(options.dataDir, options.seedDir),
    },
    {
      label: 'scheduler',
      dataPath: join(options.dataDir, SCHEDULER_FILE_NAME),
      seedPath: join(seedDir, 'scheduler.seed.json'),
      run: () => loadStartupSchedulerOwnerFile(options.dataDir, options.seedDir),
    },
    {
      label: 'capability-tier',
      dataPath: join(options.dataDir, CAPABILITY_TIER_FILE_NAME),
      seedPath: join(seedDir, 'capability-tier.seed.json'),
      run: () => loadStartupCapabilityTierOwnerFile(options.dataDir, options.seedDir),
    },
    {
      label: 'charge-policy',
      dataPath: join(options.dataDir, CHARGE_POLICY_FILE_NAME),
      seedPath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
      run: () => loadStartupChargePolicyOwnerFile(options.dataDir, options.seedDir),
    },
  ];

  const errors: string[] = [];
  for (const check of checks) {
    try {
      check.run();
    } catch (error) {
      errors.push(formatOwnerFileError({ ...check, error }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
