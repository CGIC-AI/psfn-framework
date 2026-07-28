import {
  constants as fsConstants,
  copyFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
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
import {
  COMPANIONS_FILE_NAME,
  COMPANIONS_SEED_FILE_NAME,
  resolveCompanionFleet,
  type ResolvedCompanionsFleetConfig,
} from './companions-config.js';
import {
  loadPartnerAffectShadowConfig,
  PARTNER_AFFECT_SHADOW_FILE_NAME,
  PARTNER_AFFECT_SHADOW_SEED_FILE_NAME,
} from './partner-affect-shadow-config.js';
import {
  loadIntakePolicyConfig,
  type IntakePolicyConfig,
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SEED_FILE_NAME,
} from './intake-policy-config.js';
import {
  FLEET_AUTH_FILE_NAME,
  FLEET_AUTH_SEED_FILE_NAME,
  resolveFleetAuthOwnerFile,
} from './fleet-auth-config.js';
import { PER_COMPANION_OWNER_FILES } from './settings-contract.js';

export interface StartupOwnerFileLoadOptions {
  dataDir: string;
  /**
   * Companion-owned config root (companionDataDir). Roots the per-companion
   * owner files verified here — capability-tier.json, scheduler.json,
   * charge-policy.json, and skills.json.
   * When omitted it resolves to {@link StartupOwnerFileLoadOptions.dataDir},
   * matching the legacy shared-root layout. The underlying loader still fails
   * closed on a missing per-companion file; this is a rooting default, not a
   * config fallback.
   */
  companionDataDir?: string;
  seedDir?: string;
  defaultContextWindow?: number;
  /**
   * Optional fleet-auth env-flag override consulted only for the deprecated
   * cross-check; presence of fleet-auth.json remains the single source of
   * truth for enablement.
   */
  fleetAuth?: boolean;
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

export interface StartupFleetOwnerFileVerificationOptions extends Omit<
  StartupOwnerFileLoadOptions,
  'companionDataDir'
> {
  /** Canonically resolved fleet; every entry's exact companion root is checked. */
  fleet: ResolvedCompanionsFleetConfig;
}

interface OwnerFileCheck {
  label: string;
  dataPath: string;
  seedPath: string;
  run: () => unknown;
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
  backgroundMaintenanceIntervalMs: SCHEDULER_FILE_NAME,
  salienceDecayIntervalMs: SCHEDULER_FILE_NAME,
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

export function loadStartupCompanionsOwnerFile(
  options: Pick<StartupOwnerFileLoadOptions, 'dataDir' | 'seedDir'>,
): void {
  resolveCompanionFleet({
    dataDir: options.dataDir,
    seedDir: options.seedDir,
  });
}

export function loadStartupIntakePolicyOwnerFile(
  dataDir: string,
  seedDir?: string,
): IntakePolicyConfig {
  return loadIntakePolicyConfig(dataDir, seedDir ? { seedDir } : undefined);
}

function systemOwnerFileChecks(
  options: Omit<StartupOwnerFileLoadOptions, 'companionDataDir'>,
  seedDir: string,
): OwnerFileCheck[] {
  return [
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
      label: 'backup',
      dataPath: join(options.dataDir, BACKUP_FILE_NAME),
      seedPath: join(seedDir, BACKUP_SEED_FILE_NAME),
      run: () => loadBackupConfig(options.dataDir, options.seedDir ? { seedDir: options.seedDir } : undefined),
    },
    {
      label: 'companions',
      dataPath: join(options.dataDir, COMPANIONS_FILE_NAME),
      seedPath: join(seedDir, COMPANIONS_SEED_FILE_NAME),
      run: () => loadStartupCompanionsOwnerFile({
        dataDir: options.dataDir,
        seedDir: options.seedDir,
      }),
    },
    {
      label: 'intake-policy',
      dataPath: join(options.dataDir, INTAKE_POLICY_FILE_NAME),
      seedPath: join(seedDir, INTAKE_POLICY_SEED_FILE_NAME),
      run: () => loadStartupIntakePolicyOwnerFile(options.dataDir, options.seedDir),
    },
    {
      label: 'partner-affect-shadow',
      dataPath: join(options.dataDir, PARTNER_AFFECT_SHADOW_FILE_NAME),
      seedPath: join(seedDir, PARTNER_AFFECT_SHADOW_SEED_FILE_NAME),
      run: () => loadPartnerAffectShadowConfig(
        options.dataDir,
        options.seedDir ? { seedDir: options.seedDir } : undefined,
      ),
    },
    {
      label: 'fleet-auth',
      dataPath: join(options.dataDir, FLEET_AUTH_FILE_NAME),
      seedPath: join(seedDir, FLEET_AUTH_SEED_FILE_NAME),
      run: () => resolveFleetAuthOwnerFile({
        dataDir: options.dataDir,
        envFlagOverride: options.fleetAuth,
        processMode: 'gateway',
        seedDir: options.seedDir,
      }),
    },
  ];
}

function companionOwnerFileChecks(input: {
  companionDataDir: string;
  companionLabel?: string;
  seedDir: string;
  configuredSeedDir?: string;
}): OwnerFileCheck[] {
  const labelPrefix = input.companionLabel ? `${input.companionLabel} ` : '';
  return [
    {
      label: `${labelPrefix}scheduler`,
      dataPath: join(input.companionDataDir, SCHEDULER_FILE_NAME),
      seedPath: join(input.seedDir, 'scheduler.seed.json'),
      run: () => loadStartupSchedulerOwnerFile(input.companionDataDir, input.configuredSeedDir),
    },
    {
      label: `${labelPrefix}capability-tier`,
      dataPath: join(input.companionDataDir, CAPABILITY_TIER_FILE_NAME),
      seedPath: join(input.seedDir, 'capability-tier.seed.json'),
      run: () => loadStartupCapabilityTierOwnerFile(input.companionDataDir, input.configuredSeedDir),
    },
    {
      label: `${labelPrefix}charge-policy`,
      dataPath: join(input.companionDataDir, CHARGE_POLICY_FILE_NAME),
      seedPath: join(input.seedDir, CHARGE_POLICY_SEED_FILE_NAME),
      run: () => loadStartupChargePolicyOwnerFile(input.companionDataDir, input.configuredSeedDir),
    },
    {
      label: `${labelPrefix}skills`,
      dataPath: join(input.companionDataDir, SKILLS_FILE_NAME),
      seedPath: join(input.seedDir, SKILLS_SEED_FILE_NAME),
      run: () => loadSkillsConfig(
        input.companionDataDir,
        input.configuredSeedDir ? { seedDir: input.configuredSeedDir } : undefined,
      ),
    },
  ];
}

/**
 * Owner files whose loader tolerates absence: a missing owner file is not an
 * error, so no seed needs to be staged for {@link verifyStartupOwnerFiles} to
 * pass. Today this is only fleet-auth.json — {@link resolveFleetAuthOwnerFile}
 * returns `undefined` (fleet auth disabled) when the file is absent and the
 * deprecated env flag is unset, and its distributed seed intentionally carries a
 * `replace-before-enable` placeholder key that fails validation until an
 * operator provisions real keys. Every other checked owner fails closed on a
 * missing file and therefore requires a staged seed.
 */
export const OPTIONAL_WHEN_MISSING_OWNER_FILES: ReadonlySet<string> = new Set<string>([
  FLEET_AUTH_FILE_NAME,
]);

/** Static description of one owner-file check, independent of runtime roots. */
export interface OwnerFileSeedDescriptor {
  label: string;
  ownerFileName: string;
  seedFileName: string;
  scope: 'system' | 'companion';
  /** True when the loader tolerates a missing owner file (no seed required). */
  optionalWhenMissing: boolean;
}

const OWNER_FILE_DESCRIPTOR_PLACEHOLDER_DIR = '__owner-file-descriptor-placeholder__';

function toOwnerFileSeedDescriptor(
  check: OwnerFileCheck,
  scope: 'system' | 'companion',
): OwnerFileSeedDescriptor {
  const ownerFileName = basename(check.dataPath);
  return {
    label: check.label,
    ownerFileName,
    seedFileName: basename(check.seedPath),
    scope,
    optionalWhenMissing: OPTIONAL_WHEN_MISSING_OWNER_FILES.has(ownerFileName),
  };
}

/**
 * Canonical description of every owner-file check {@link verifyStartupOwnerFiles}
 * runs, derived from the same check builders. Consumers (e.g. the repository
 * `verify:startup-owner-files` seed script) use this to stay in parity with the
 * guard instead of duplicating the owner list and silently drifting when a new
 * required owner is added. Only static metadata (label, owner/seed file names,
 * rooting scope) is read; the checks are never executed here, so the placeholder
 * roots are safe.
 */
export function describeStartupOwnerFileChecks(): OwnerFileSeedDescriptor[] {
  const system = systemOwnerFileChecks(
    { dataDir: OWNER_FILE_DESCRIPTOR_PLACEHOLDER_DIR },
    OWNER_FILE_DESCRIPTOR_PLACEHOLDER_DIR,
  ).map(check => toOwnerFileSeedDescriptor(check, 'system'));
  const companion = companionOwnerFileChecks({
    companionDataDir: OWNER_FILE_DESCRIPTOR_PLACEHOLDER_DIR,
    seedDir: OWNER_FILE_DESCRIPTOR_PLACEHOLDER_DIR,
  }).map(check => toOwnerFileSeedDescriptor(check, 'companion'));
  return [...system, ...companion];
}

function runOwnerFileChecks(checks: readonly OwnerFileCheck[]): StartupOwnerFileVerificationResult {
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

/** Validate exactly the owner files rooted at one companion's data directory. */
export function verifyCompanionStartupOwnerFiles(options: {
  companionDataDir: string;
  companionLabel?: string;
  seedDir?: string;
}): StartupOwnerFileVerificationResult {
  const seedDir = ownerFileSeedDir(options);
  return runOwnerFileChecks(companionOwnerFileChecks({
    companionDataDir: options.companionDataDir,
    companionLabel: options.companionLabel,
    seedDir,
    configuredSeedDir: options.seedDir,
  }));
}

/**
 * Seed one new companion root from the canonical per-companion owner registry.
 *
 * Existing destinations fail closed. If a copy or validation fails, only files
 * created by this invocation are removed.
 */
export function seedCompanionStartupOwnerFiles(options: {
  companionDataDir: string;
  companionLabel?: string;
  seedDir: string;
}): string[] {
  const copiedPaths: string[] = [];
  try {
    for (const ownerFile of PER_COMPANION_OWNER_FILES) {
      const sourcePath = join(
        options.seedDir,
        ownerFile.replace(/\.json$/u, '.seed.json'),
      );
      const destinationPath = join(options.companionDataDir, ownerFile);
      copyFileSync(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
      copiedPaths.push(destinationPath);
    }
    const verification = verifyCompanionStartupOwnerFiles(options);
    if (!verification.ok) {
      throw new Error(verification.errors.join('\n'));
    }
    return copiedPaths;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const copiedPath of copiedPaths.reverse()) {
      try {
        unlinkSync(copiedPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Per-companion owner-file seeding failed and rollback left residue',
      );
    }
    throw error;
  }
}

export function verifyStartupOwnerFiles(
  options: StartupOwnerFileLoadOptions,
): StartupOwnerFileVerificationResult {
  const seedDir = ownerFileSeedDir(options);
  // Whole-file per-companion owners are verified at the companion root.
  // Defaults to dataDir only for the legacy shared-root layout.
  const companionDataDir = options.companionDataDir ?? options.dataDir;
  return runOwnerFileChecks([
    ...systemOwnerFileChecks(options, seedDir),
    ...companionOwnerFileChecks({
      companionDataDir,
      seedDir,
      configuredSeedDir: options.seedDir,
    }),
  ]);
}

/** Verify global owners once, then every exact root from the resolved fleet. */
export function verifyStartupFleetOwnerFiles(
  options: StartupFleetOwnerFileVerificationOptions,
): StartupOwnerFileVerificationResult {
  const seedDir = ownerFileSeedDir(options);
  return runOwnerFileChecks([
    ...systemOwnerFileChecks({
      dataDir: options.dataDir,
      seedDir: options.seedDir,
      defaultContextWindow: options.defaultContextWindow,
      fleetAuth: options.fleetAuth,
    }, seedDir),
    ...options.fleet.companions.flatMap(companion => companionOwnerFileChecks({
      companionDataDir: companion.companionDataDir,
      companionLabel: `companion ${companion.companionId}`,
      seedDir,
      configuredSeedDir: options.seedDir,
    })),
  ]);
}
