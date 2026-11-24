/**
 * `@psfn/core` primary entrypoint: standalone companion runtime, inner-life
 * policy config loader, core defaults, session integrity, embeddings, hosted
 * automata execution, canonical tool catalog, and bundled policy seeds.
 */
export {
  startCompanionRuntime,
  type CompanionGardenHandles,
  type CompanionRuntime,
  type StartCompanionRuntimeOptions,
} from '../../../src/app/companion/runtime.js';
export type { CompanionPersistenceRuntime } from '../../../src/app/companion/persistence-runtime.js';
export {
  AUTOMATA_FILE_NAME,
  AUTOMATA_SEED_FILE_NAME,
  INNER_LIFE_SETTINGS_FILE_NAME,
  INNER_LIFE_SETTINGS_SEED_FILE_NAME,
  assertAutomataReviewerModelResolvable,
  listEnabledModelRegistrySlotKeys,
  loadAutomataPolicyConfig,
  loadAutomataPolicySeedDefaults,
  loadInnerLifeConfig,
  loadInnerLifePolicySettings,
  type InnerLifeConfig,
  type InnerLifeConfigLoadOptions,
  type InnerLifePolicySettings,
} from '../../../src/system/config/inner-life-config.js';
export {
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  createDefaultCompositionalPolicyConfig,
  createDefaultEmoSimProactivitySettings,
  createDefaultObserverEvalSidecarSettings,
  createDefaultSessionTailCacheSettings,
  sanitizeCoreSubstrateConfig,
  type CoreSubstrateConfig,
  type SubstrateConfig,
} from '../../../src/system/config/runtime-config-contracts.js';
export { createDefaultMemoryRetrievalPolicy } from '../../../src/system/config/memory-retrieval-policy.js';
export { createDefaultBiographicalDepthPolicy } from '../../../src/system/config/biographical-depth-policy.js';
export { createDefaultBiographicalCandidatePolicy } from '../../../src/system/config/biographical-candidate-policy.js';
export { createDefaultMemoryPresentationProfile } from '../../../src/system/config/memory-presentation-profile.js';
export { createDefaultGroupMemorySettings } from '../../../src/system/config/group-memory-config.js';
export { createDefaultEmotionScopingSettings } from '../../../src/system/config/emotion-scoping-config.js';
export { createDefaultNarrativeEmotionAppraisalSettings } from '../../../src/system/config/narrative-emotion-appraisal-config.js';
export {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
} from '../../../src/shared/context-budget.js';
export { createSessionHmacBoundaryService } from '../../../src/persistence/journals/hmac-boundary.js';
export {
  createKeyringIntegrityProvider,
  type SessionIntegrityProvider,
} from '../../../src/persistence/sessions/store-primitives.js';
export type { SessionHmacKeyring } from '../../../src/persistence/journals/journal/types.js';
export type { JournalEntry } from '../../../src/core/session/types.js';
export type { ProviderRuntime } from '../../../src/primitives/llm/provider-runtime.js';
export {
  ApiEmbeddingProvider,
  DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG,
  OllamaEmbeddingProvider,
  TransformersEmbeddingProvider,
  createEmbeddingProviderFromConfig,
  resolveEmbeddingProviderProvenanceFromConfig,
  resolveProjectTransformersCacheDir,
  type EmbeddingProviderKind,
  type EmbeddingRuntimeProvider,
} from '../../../src/faculties/memory/embedding.js';
export { envCredential } from '../../../src/shared/contracts/credential-contracts.js';
export type { ModelUsageEventInput, ModelUsageRecorder } from '../../../src/shared/telemetry/model-usage.js';
export type { AgentResponse, SubstrateMessage } from '../../../src/shared/contracts/runtime-base.js';
export type { TrustLevel } from '../../../src/shared/contracts/trust-contracts.js';
export { createTurnId } from '../../../src/core/turns/id.js';
export {
  resolveRuntimePathSnapshotFromConfig,
  type RuntimePathSnapshot,
} from '../../../src/persistence/layout.js';
export {
  HostedAutomataExecutor,
  type HostedAutomataEvent,
  type HostedAutomataPolicy,
  type SubagentHostExecutionPort,
} from '../../../src/faculties/subagents/host-execution.js';
export {
  CANONICAL_FIRST_PARTY_TOOL_SURFACES,
  type CanonicalToolSurfaceEntry,
} from '../../../src/core/agent/tool-surface/registry.js';
export { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../src/core/agent/tool-surface/descriptions.js';
export { AUTOMATA_BUS_TOOL_ACTIONS } from '../../../src/faculties/automata/bus/worker-access-contracts.js';
export { automataBusToolParametersForActions } from '../../../src/faculties/automata/bus/worker-access-operation.js';
import {
  CANONICAL_FIRST_PARTY_TOOL_SURFACES as ALL_CANONICAL_TOOL_SURFACES,
  type CanonicalToolSurfaceEntry,
} from '../../../src/core/agent/tool-surface/registry.js';

const COMPANION_CORE_TOOL_NAMES = new Set([
  'tool_search',
  'execute',
  'toolset',
  'response_control',
  'identity',
  'north_star',
  'session',
  'contacts',
  'orient',
  'concerns',
  'subagent',
  'automata_bus',
  'memory',
  'scratchpad',
  'journal',
  'schedule',
]);

/** Canonical tool surfaces exposed by the standalone companion core runtime. */
export const COMPANION_CORE_TOOL_SURFACES: readonly CanonicalToolSurfaceEntry[] = Object.freeze(
  ALL_CANONICAL_TOOL_SURFACES.filter((entry) => COMPANION_CORE_TOOL_NAMES.has(entry.name)),
);
export {
  COMPANION_SEED_DIR,
  COMPANION_SEED_FILES,
  type CompanionSeedFileName,
} from './seeds.js';
