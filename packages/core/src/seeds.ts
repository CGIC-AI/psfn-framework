/**
 * Canonical companion policy seed directory and manifest shipped with `@psfn/core`.
 */
export const COMPANION_SEED_FILES = Object.freeze([
  'automata-policy.seed.json',
  'capability-tier.seed.json',
  'companions.seed.json',
  'intake-policy.seed.json',
  'runtime-prompt-layers.seed.json',
  'scheduler.seed.json',
  'settings.seed.json',
  'subagent-roles.seed.json',
  'trust-policy.seed.json',
] as const);

export type CompanionSeedFileName = typeof COMPANION_SEED_FILES[number];

/** URL to the packaged `config/` directory containing the canonical `.seed.json` files. */
export const COMPANION_SEED_DIR = new URL('../config/', import.meta.url);
