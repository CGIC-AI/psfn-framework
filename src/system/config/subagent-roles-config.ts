import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRequiredJson, loadSeedJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  createEmptySubagentRoleRegistryConfig,
  parseSubagentRoleRegistryConfig,
  type SubagentRoleRegistryConfig,
} from '../../faculties/subagents/role-registry.js';

/**
 * bead 7ym.2.1 — schema-owned owner file for the subagent role registry. Roles
 * are a cluster-global vocabulary (system-data owned), loaded fail-closed:
 * - a malformed file throws (a corrupt registry must never silently grant a
 *   role or a widened toolset);
 * - an absent file resolves to the empty registry (the feature is simply
 *   unconfigured — an unknown-role spawn still fails closed downstream).
 * There is no env-var side channel; the JSON owner file is the only authority.
 */
export const SUBAGENT_ROLES_FILE_NAME = 'subagent-roles.json';
export const SUBAGENT_ROLES_SEED_FILE_NAME = 'subagent-roles.seed.json';

interface SubagentRolesLoadOptions {
  seedDir?: string;
}

function validateSubagentRolesConfig(raw: unknown, sourcePath: string): SubagentRoleRegistryConfig {
  return parseSubagentRoleRegistryConfig(raw, sourcePath);
}

export function loadSubagentRolesConfig(
  dataDir: string,
  options: SubagentRolesLoadOptions = {},
): SubagentRoleRegistryConfig {
  const dataPath = join(dataDir, SUBAGENT_ROLES_FILE_NAME);
  if (!existsSync(dataPath)) {
    return createEmptySubagentRoleRegistryConfig();
  }
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath,
    examplePath: join(seedDir, SUBAGENT_ROLES_SEED_FILE_NAME),
    validate: validateSubagentRolesConfig,
  });
}

export function loadSubagentRolesSeedDefaults(
  options: SubagentRolesLoadOptions = {},
): SubagentRoleRegistryConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadSeedJson({
    seedPath: join(seedDir, SUBAGENT_ROLES_SEED_FILE_NAME),
    validate: validateSubagentRolesConfig,
  });
}

export function saveSubagentRolesConfig(
  dataDir: string,
  nextConfig: unknown,
): SubagentRoleRegistryConfig {
  const validated = validateSubagentRolesConfig(nextConfig, SUBAGENT_ROLES_FILE_NAME);
  writeJsonAtomic(join(dataDir, SUBAGENT_ROLES_FILE_NAME), validated);
  return validated;
}
