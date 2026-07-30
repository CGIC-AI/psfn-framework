import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModelsConfig } from '../../../system/config/models-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

export function createIntakeScreenerTestConfig(
  overrides: Partial<SubstrateConfig> = {},
): SubstrateConfig {
  return {
    primaryModel: 'test/chat',
    primaryProvider: 'openrouter',
    extractionModel: 'test/background',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 8_192,
    extractionMaxTokens: 4_096,
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    ...overrides,
  };
}

export function loadSeedIntakeScreenerTestConfig(dataDir: string): SubstrateConfig {
  const seedDir = join(process.cwd(), 'config');
  copyFileSync(
    join(seedDir, 'models.seed.json'),
    join(dataDir, 'models.json'),
  );
  return createIntakeScreenerTestConfig({
    dataDir,
    ...loadModelsConfig(dataDir, {
      seedDir,
      defaultContextWindow: 128_000,
    }),
  });
}
