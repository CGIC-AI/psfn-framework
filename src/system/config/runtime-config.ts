import type { SubstrateConfig } from './runtime-config-contracts.js';
import { applySettings, loadSettings, splitSettingsByDomain } from '../settings.js';
import { loadModelsConfig } from './models-config.js';
import {
  applyProvidersRuntimeConfig,
  loadProvidersConfig,
} from './providers-config.js';
import { resolveRuntimeSchedulerConfig } from './scheduler-runtime.js';
import { loadCapabilityTierConfig } from './capability-tier-config.js';
import { loadChargePolicyConfig } from './charge-policy-config.js';
import { resolveEffectiveRuntimeSettings } from './settings-overlay.js';
import { assertModelPurposeSelectionResolvable } from './model-selection-config.js';
import { resolveConfiguredCompanionDataDir } from '../../persistence/layout.js';
import { applyMissingRuntimeSettingsDefaults } from './settings-owner-backfill.js';
import { SETTINGS_FILE_NAME } from '../settings/contracts.js';

export function hydrateJsonBackedRuntimeConfig(
  config: SubstrateConfig,
  options: { seedDir?: string } = {},
): SubstrateConfig {
  const dataDir = config.dataDir;
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR;
  const loadOptions = seedDir ? { seedDir } : undefined;

  // psfn-framework-bxnyu: the operator process hydrates its runtime config
  // here rather than through the startup owner-file checks, so it needs the
  // same in-memory adaptation for required contract fields an owner file
  // written before them cannot carry.
  const savedSettings = applyMissingRuntimeSettingsDefaults(
    loadSettings(dataDir, loadOptions),
    {
      ...(seedDir ? { seedDir } : {}),
      sourceLabel: SETTINGS_FILE_NAME,
    },
  );
  const settingsDomains = splitSettingsByDomain(savedSettings);
  // Per-companion overlay (dnll.1): merge companion-data/settings.overlay.json
  // over the global runtime settings. Absent overlay = byte-identical behavior.
  const effectiveRuntimeSettings = resolveEffectiveRuntimeSettings(
    settingsDomains.runtime,
    companionDataDir,
  );
  applySettings(config, effectiveRuntimeSettings);

  const modelsConfig = loadModelsConfig(dataDir, {
    ...loadOptions,
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  // 23pp: every per-companion model selection must resolve to an enabled
  // models.json registry entry — fail closed at startup, never at first call.
  assertModelPurposeSelectionResolvable(config);
  applyProvidersRuntimeConfig(config, loadProvidersConfig(dataDir, loadOptions));

  // scheduler.json is a per-companion owner file (dnll.3): root it at the
  // companion data dir so fleet companions can hold distinct circadian schedules.
  // Salience decay cadence is decoupled from config (origin/main): the scheduler
  // owns that cadence directly, so we no longer copy it onto the runtime config.
  resolveRuntimeSchedulerConfig({
    dataDir: companionDataDir,
    ...(seedDir ? { seedDir } : {}),
  });

  // capability-tier.json is a per-companion owner file (dnll.2): root it at the
  // companion data dir so fleet companions can hold distinct maturation tiers.
  config.capabilityTier = loadCapabilityTierConfig(companionDataDir, loadOptions).tier;
  config.chargePolicy = loadChargePolicyConfig(companionDataDir, loadOptions);

  return config;
}
