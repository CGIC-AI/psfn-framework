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

export function hydrateJsonBackedRuntimeConfig(
  config: SubstrateConfig,
  options: { seedDir?: string } = {},
): SubstrateConfig {
  const dataDir = config.dataDir;
  const companionDataDir = resolveConfiguredCompanionDataDir(config);
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR;
  const loadOptions = seedDir ? { seedDir } : undefined;

  const savedSettings = loadSettings(dataDir, loadOptions);
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
