import { join } from 'node:path';
import { loadRequiredJson, loadSeedJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  parseAutomataOwnerPolicy,
  type AutomataOwnerPolicy,
} from '../../faculties/automata/registry-contract.js';
import { loadModelsConfig } from './models-config.js';
import { AUTOMATA_FILE_NAME, assertAutomataReviewerModelResolvable } from './automata-reviewer-model-contract.js';

export { AUTOMATA_FILE_NAME };
export const AUTOMATA_SEED_FILE_NAME = 'automata-policy.seed.json';

export function loadAutomataPolicyConfig(
  dataDir: string,
  options: { seedDir?: string } = {},
): AutomataOwnerPolicy {
  const dataPath = join(dataDir, AUTOMATA_FILE_NAME);
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const policy = loadRequiredJson({
    dataPath,
    examplePath: join(seedDir, AUTOMATA_SEED_FILE_NAME),
    validate: (raw, sourcePath) => parseAutomataOwnerPolicy(raw, sourcePath),
  });
  if (policy.bus.reviewer.enabled) {
    assertAutomataReviewerModelResolvable(policy, loadModelsConfig(dataDir, options).modelRegistry);
  }
  return policy;
}

export function loadAutomataPolicySeedDefaults(
  options: { seedDir?: string } = {},
): AutomataOwnerPolicy {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadSeedJson({
    seedPath: join(seedDir, AUTOMATA_SEED_FILE_NAME),
    validate: (raw, sourcePath) => parseAutomataOwnerPolicy(raw, sourcePath),
  });
}

export function saveAutomataPolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): AutomataOwnerPolicy {
  const validated = parseAutomataOwnerPolicy(nextConfig, AUTOMATA_FILE_NAME);
  if (validated.bus.reviewer.enabled) {
    assertAutomataReviewerModelResolvable(validated, loadModelsConfig(dataDir).modelRegistry);
  }
  writeJsonAtomic(join(dataDir, AUTOMATA_FILE_NAME), validated);
  return validated;
}
