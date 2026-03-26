import type { SubstrateConfig } from '../types.js';
import { applySettings, loadSettings, splitSettingsByDomain } from '../settings.js';
import { loadModelsConfig } from './models-config.js';
import {
  applyProvidersRuntimeConfig,
  loadProvidersConfig,
} from './providers-config.js';
import { resolveRuntimeSchedulerConfig } from './scheduler-runtime.js';
import { loadCapabilityTierConfig } from './capability-tier-config.js';

export function hydrateJsonBackedRuntimeConfig(
  config: SubstrateConfig,
  options: { seedDir?: string } = {},
): SubstrateConfig {
  const dataDir = config.dataDir;
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR;
  const loadOptions = seedDir ? { seedDir } : undefined;

  const savedSettings = loadSettings(dataDir, loadOptions);
  const settingsDomains = splitSettingsByDomain(savedSettings);
  applySettings(config, settingsDomains.runtime);

  const modelsConfig = loadModelsConfig(dataDir, {
    ...loadOptions,
    defaultContextWindow: config.defaultContextWindow,
  });
  applySettings(config, modelsConfig);
  applyProvidersRuntimeConfig(config, loadProvidersConfig(dataDir, loadOptions));

  const schedulerConfig = resolveRuntimeSchedulerConfig({
    dataDir,
    ...(seedDir ? { seedDir } : {}),
  });
  config.maintenanceIntervalMs = schedulerConfig.salienceDecayIntervalMs;

  config.capabilityTier = loadCapabilityTierConfig(dataDir, loadOptions).tier;

  return config;
}
