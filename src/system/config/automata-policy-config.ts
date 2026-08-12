import { join } from 'node:path';
import { loadRequiredJson, loadSeedJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  parseAutomataOwnerPolicy,
  type AutomataOwnerPolicy,
} from '../../faculties/automata/registry-contract.js';

export const AUTOMATA_FILE_NAME = 'automata-policy.json';
export const AUTOMATA_SEED_FILE_NAME = 'automata-policy.seed.json';

export function loadAutomataPolicyConfig(
  dataDir: string,
  options: { seedDir?: string } = {},
): AutomataOwnerPolicy {
  const dataPath = join(dataDir, AUTOMATA_FILE_NAME);
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath,
    examplePath: join(seedDir, AUTOMATA_SEED_FILE_NAME),
    validate: (raw, sourcePath) => parseAutomataOwnerPolicy(raw, sourcePath),
  });
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
  writeJsonAtomic(join(dataDir, AUTOMATA_FILE_NAME), validated);
  return validated;
}
