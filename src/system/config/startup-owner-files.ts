import { join } from 'node:path';
import type { EditableSettings, SettingsDomainSplit } from '../settings.js';
import { SETTINGS_FILE_NAME } from '../settings/contracts.js';
import { splitSettingsByDomain, loadSettings } from '../settings.js';
import {
  loadStartupModelsConfig,
  type ModelsLoadResult,
  MODELS_FILE_NAME,
} from './models-config.js';
import {
  loadStartupProvidersConfig,
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
import {
  BACKUP_FILE_NAME,
  BACKUP_SEED_FILE_NAME,
  loadBackupConfig,
} from './backup-config.js';
import {
  loadSkillsConfig,
  SKILLS_FILE_NAME,
  SKILLS_SEED_FILE_NAME,
} from './skills-config.js';

export interface StartupOwnerFileLoadOptions {
  dataDir: string;
  seedDir?: string;
  defaultContextWindow?: number;
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
  error: unknown;
}): string {
  const cause = input.error instanceof Error ? input.error.message : String(input.error);
  return `${input.label} owner-file validation failed at ${input.dataPath}: ${cause}`;
}

const SETTINGS_OWNER_HINT_BY_KEY: Record<string, string> = {
  modelRegistry: MODELS_FILE_NAME,
  primaryModel: MODELS_FILE_NAME,
  primaryProvider: MODELS_FILE_NAME,
  primaryMaxTokens: MODELS_FILE_NAME,
  extractionModel: MODELS_FILE_NAME,
  extractionProvider: MODELS_FILE_NAME,
  extractionMaxTokens: MODELS_FILE_NAME,
  modelCatalog: MODELS_FILE_NAME,
  modelRoleAssignments: MODELS_FILE_NAME,
  modelRoster: MODELS_FILE_NAME,
  maintenanceIntervalMs: SCHEDULER_FILE_NAME,
  capabilityTier: CAPABILITY_TIER_FILE_NAME,
};

function assertRuntimeSettingsOwnerFileIsCanonical(settingsDomains: SettingsDomainSplit): void {
  if (settingsDomains.legacyKeys.length === 0) return;

  const ownerHints = settingsDomains.legacyKeys
    .map((key) => `${key}->${SETTINGS_OWNER_HINT_BY_KEY[key] ?? 'canonical owner file'}`)
    .join(', ');
  throw new Error(
    'Unsupported cross-domain keys in settings.json: '
    + `${settingsDomains.legacyKeys.join(', ')}. `
    + 'settings.json is runtime-owned only; move these keys to their canonical owner files before startup '
    + `(${ownerHints}).`,
  );
}

export function loadStartupRuntimeSettingsOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir'>,
): Pick<StartupOwnerFileState, 'runtimeSettings' | 'settingsDomains'> {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const runtimeSettings = loadSettings(options.dataDir, loadOptions);
  const settingsDomains = splitSettingsByDomain(runtimeSettings);
  assertRuntimeSettingsOwnerFileIsCanonical(settingsDomains);
  return {
    runtimeSettings,
    settingsDomains,
  };
}

export function loadStartupModelsOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir' | 'defaultContextWindow'>,
): ModelsLoadResult {
  const modelsLoadResult = loadStartupModelsConfig(options.dataDir, {
    defaultContextWindow: options.defaultContextWindow,
  });
  return modelsLoadResult;
}

export function loadStartupProvidersOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir'>,
): ProvidersLoadResult {
  const providersLoadResult = loadStartupProvidersConfig(options.dataDir, {
    seedDir: options.seedDir,
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
    {
      label: 'backup',
      dataPath: join(options.dataDir, BACKUP_FILE_NAME),
      seedPath: join(seedDir, BACKUP_SEED_FILE_NAME),
      run: () => loadBackupConfig(options.dataDir, options.seedDir ? { seedDir: options.seedDir } : undefined),
    },
    {
      label: 'skills',
      dataPath: join(options.dataDir, SKILLS_FILE_NAME),
      seedPath: join(seedDir, SKILLS_SEED_FILE_NAME),
      run: () => loadSkillsConfig(options.dataDir, options.seedDir ? { seedDir: options.seedDir } : undefined),
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
