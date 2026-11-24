// ── Inner-life policy loader ──
//
// Loads the companion core's inner-life policy owner files directly through the
// canonical policy modules, without depending on host-only owner files
// (models.json, channels.json, gateway, fleet, voice, image, or full settings
// schema):
//
// - scheduler.json       loadSchedulerConfig (companion data root)
// - capability-tier.json loadCapabilityTierConfig (companion data root)
// - trust-policy.json    loadTrustPolicyConfig (system data root)
// - subagent-roles.json  loadSubagentRolesConfig (system data root)
// - automata-policy.json loadAutomataPolicyConfig (system data root; host supplies modelRegistry)
// - settings.json        inner-life policy keys normalized with core defaults

import { join } from 'node:path';
import type { AutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
import type { SubagentRoleRegistryConfig } from '../../faculties/subagents/role-registry.js';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  AUTOMATA_FILE_NAME,
  AUTOMATA_SEED_FILE_NAME,
  loadAutomataPolicyConfig,
  loadAutomataPolicySeedDefaults,
} from './automata-policy-config.js';
import { assertAutomataReviewerModelResolvable } from './automata-reviewer-model-contract.js';
import { loadCapabilityTierConfig, type CapabilityTierConfig } from './capability-tier-config.js';
import {
  createDefaultBiographicalCandidatePolicy,
  normalizeBiographicalCandidatePolicy,
} from './biographical-candidate-policy.js';
import {
  createDefaultBiographicalDepthPolicy,
  normalizeBiographicalDepthPolicy,
} from './biographical-depth-policy.js';
import {
  createDefaultEmotionScopingSettings,
  normalizeEmotionScopingSettings,
} from './emotion-scoping-config.js';
import {
  createDefaultGroupMemorySettings,
  normalizeGroupMemorySettings,
} from './group-memory-config.js';
import { loadRequiredJson } from './load-or-seed.js';
import { normalizeMemoryDeletionPolicy } from './memory-deletion-policy.js';
import {
  createDefaultMemoryPresentationProfile,
  normalizeMemoryPresentationProfile,
} from './memory-presentation-profile.js';
import {
  createDefaultMemoryRetrievalPolicy,
  normalizeMemoryRetrievalPolicy,
} from './memory-retrieval-policy.js';
import { listEnabledModelRegistrySlotKeys } from './model-selection-config.js';
import {
  createDefaultNarrativeEmotionAppraisalSettings,
  normalizeNarrativeEmotionAppraisalSettings,
} from './narrative-emotion-appraisal-config.js';
import {
  createDefaultCompositionalPolicyConfig,
  createDefaultEmoSimProactivitySettings,
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from './runtime-config-contracts.js';
import { loadSchedulerConfig, type SchedulerRuntimeConfig } from './scheduler-config.js';
import { loadSubagentRolesConfig } from './subagent-roles-config.js';
import { loadTrustPolicyConfig, type TrustPolicyConfig } from './trust-policy-config.js';

export {
  AUTOMATA_FILE_NAME,
  AUTOMATA_SEED_FILE_NAME,
  assertAutomataReviewerModelResolvable,
  listEnabledModelRegistrySlotKeys,
  loadAutomataPolicyConfig,
  loadAutomataPolicySeedDefaults,
};

export const INNER_LIFE_SETTINGS_FILE_NAME = 'settings.json';
export const INNER_LIFE_SETTINGS_SEED_FILE_NAME = 'settings.seed.json';

/** The SubstrateConfig fields that settings.json supplies to the inner-life loops. */
export type InnerLifePolicySettings = Required<Pick<SubstrateConfig,
  | 'groupMemory'
  | 'emotionScoping'
  | 'narrativeEmotionAppraisal'
  | 'memoryRetrievalPolicy'
  | 'biographicalDepthPolicy'
  | 'biographicalCandidatePolicy'
  | 'memoryPresentationProfile'
  | 'compositionalPolicy'
  | 'observerEvalSidecar'
  | 'emosimProactivity'
>> & Pick<SubstrateConfig, 'memoryDeletionPolicy'>;

export interface InnerLifeConfig {
  scheduler: SchedulerRuntimeConfig;
  capabilityTier: CapabilityTierConfig;
  trustPolicy: TrustPolicyConfig;
  subagentRoles: SubagentRoleRegistryConfig;
  automataPolicy: AutomataOwnerPolicy;
  settings: InnerLifePolicySettings;
}

export interface InnerLifeConfigLoadOptions {
  /** System data root. */
  dataDir: string;
  /** Companion data root for per-companion files; defaults to dataDir. */
  companionDataDir?: string;
  /** Seed directory; each loader falls back to CONFIG_DIR, then ./config. */
  seedDir?: string;
  /** Host-supplied model registry used when the automata reviewer is enabled. */
  modelRegistry?: CanonicalModelRegistry;
}

/** Load every inner-life policy file. Missing or invalid files fail closed. */
export function loadInnerLifeConfig(options: InnerLifeConfigLoadOptions): InnerLifeConfig {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const companionDataDir = options.companionDataDir ?? options.dataDir;
  return {
    scheduler: loadSchedulerConfig(companionDataDir, loadOptions),
    capabilityTier: loadCapabilityTierConfig(companionDataDir, loadOptions),
    trustPolicy: loadTrustPolicyConfig(options.dataDir, loadOptions),
    subagentRoles: loadSubagentRolesConfig(options.dataDir, loadOptions),
    automataPolicy: loadAutomataPolicyConfig(options.dataDir, {
      ...loadOptions,
      modelRegistry: options.modelRegistry ?? { schemaVersion: 1, models: [] },
    }),
    settings: loadInnerLifePolicySettings(options.dataDir, loadOptions),
  };
}

/**
 * Load settings.json inner-life policy keys fail-closed with the seed as the
 * example path, normalizing each present policy key over core defaults.
 */
export function loadInnerLifePolicySettings(
  dataDir: string,
  options: { seedDir?: string } = {},
): InnerLifePolicySettings {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, INNER_LIFE_SETTINGS_FILE_NAME),
    examplePath: join(seedDir, INNER_LIFE_SETTINGS_SEED_FILE_NAME),
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return normalizeInnerLifePolicySettings(raw);
    },
  });
}

function normalizeInnerLifePolicySettings(
  settings: Record<string, unknown>,
): InnerLifePolicySettings {
  const memoryDeletionPolicy = 'memoryDeletionPolicy' in settings
    ? normalizeMemoryDeletionPolicy(settings.memoryDeletionPolicy, 'memoryDeletionPolicy')
    : undefined;
  return {
    groupMemory: 'groupMemory' in settings
      ? normalizeGroupMemorySettings(settings.groupMemory, 'groupMemory')
      : createDefaultGroupMemorySettings(),
    emotionScoping: 'emotionScoping' in settings
      ? normalizeEmotionScopingSettings(settings.emotionScoping, 'emotionScoping')
      : createDefaultEmotionScopingSettings(),
    narrativeEmotionAppraisal: 'narrativeEmotionAppraisal' in settings
      ? normalizeNarrativeEmotionAppraisalSettings(
        settings.narrativeEmotionAppraisal,
        'narrativeEmotionAppraisal',
      )
      : createDefaultNarrativeEmotionAppraisalSettings(),
    memoryRetrievalPolicy: 'memoryRetrievalPolicy' in settings
      ? normalizeMemoryRetrievalPolicy(settings.memoryRetrievalPolicy, 'memoryRetrievalPolicy')
      : createDefaultMemoryRetrievalPolicy(),
    biographicalDepthPolicy: 'biographicalDepthPolicy' in settings
      ? normalizeBiographicalDepthPolicy(settings.biographicalDepthPolicy, 'biographicalDepthPolicy')
      : createDefaultBiographicalDepthPolicy(),
    biographicalCandidatePolicy: 'biographicalCandidatePolicy' in settings
      ? normalizeBiographicalCandidatePolicy(
        settings.biographicalCandidatePolicy,
        'biographicalCandidatePolicy',
      )
      : createDefaultBiographicalCandidatePolicy(),
    ...(memoryDeletionPolicy ? { memoryDeletionPolicy } : {}),
    memoryPresentationProfile: 'memoryPresentationProfile' in settings
      ? normalizeMemoryPresentationProfile(
        settings.memoryPresentationProfile,
        'memoryPresentationProfile',
      )
      : createDefaultMemoryPresentationProfile(),
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    emosimProactivity: createDefaultEmoSimProactivitySettings(),
  };
}
