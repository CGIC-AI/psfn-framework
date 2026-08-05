// Shared runtime wiring.
// Common primitives used by both split-runtime and gateway agent mode.

import type { CapabilityTier, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ToolRegistrarTarget } from '../../../core/agent/tool-registrar.js';
import {
  DEFAULT_REPL_CONFIG,
  type REPLConfig,
  type TierAnalysisWorkbenchBudget,
  validateAnalysisWorkbenchDirectResponseTimeoutMs,
} from '../../../core/tools/analysis-workbench/types.js';
import type { MessageSender } from '../../../system/lifecycle/notifications.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { wireFilesystemRuntime, type FilesystemRuntimeTarget } from '../../../boundary/integrations/filesystem/runtime-wiring.js';
import type { SessionManager } from '../../../core/session/manager.js';
import {
  createSessionTool,
} from '../../../core/tools/session.js';
import { resolveSessionsDir } from '../../../persistence/layout.js';
import { PromptLayerStore } from '../../../core/identity/prompt-store.js';
import { PromptComposer } from '../../../core/identity/prompt-composer.js';
import { PromptRegistryStore } from '../../../core/identity/prompt-registry.js';
import type { PromptRegistryStatePort } from '../../../core/identity/prompt-state-port.js';
import { ensureRuntimePromptLayers } from '../../../core/identity/runtime-prompt-layers.js';
import { ensureTemporalRulesPromptLayer } from '../../../core/identity/temporal-rules-layer.js';
import {
  ensureSystemLanguagePromptLayer,
  installSystemLanguagePromptLayerSource,
} from '../../../core/identity/system-language.js';
import {
  type CharacterCardVersionStore,
} from '../../../core/identity/card-versioning.js';
import { buildCharacterPromptTemplateVariables } from '../../../core/identity/loader.js';
import {
  createIdentityTool,
  type IdentityToolOptions,
} from '../../../core/identity/prompt-tools.js';
import { NorthStarStore } from '../../../faculties/north-star/store.js';
import {
  createNorthStarTool,
} from '../../../faculties/north-star/tools.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import {
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolvePromptLastKnownGoodPath,
  resolvePromptHistoryPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import { createSystemTool } from '../../../core/tools/lifecycle.js';
import {
  wireReflectionRuntime as wireCoreReflectionRuntime,
  type ReflectionAgent,
  type ReflectionRuntimeOptions,
} from '../../../core/scheduler/reflection-runtime.js';

const log = createComponentLogger('SharedWiring');

export interface PromptRuntimeTarget extends ToolRegistrarTarget {
  promptComposer: PromptComposer | null;
}

export interface PromptCacheInvalidationOptions {
  invalidatePromptCache?: (reason: string) => void;
}

export type CharacterCardRuntimeTarget = ToolRegistrarTarget;

export function buildCharacterPromptVariablesProvider(
  cardStore: Pick<CharacterCardVersionStore, 'getCurrent'>,
): () => Record<string, string> {
  return () => buildCharacterPromptTemplateVariables(cardStore.getCurrent().card);
}

export type FilesystemToolRuntimeTarget = ToolRegistrarTarget & FilesystemRuntimeTarget;

/**
 * Wire prompt stack storage, composition, and tools.
 * Shared across the split runtime entrypoints to keep behavior in sync.
 */
export function wirePromptRuntime(
  target: PromptRuntimeTarget,
  dataDir: string,
  baseSystemPrompt: string,
  options: IdentityToolOptions & PromptCacheInvalidationOptions,
): PromptLayerStore {
  const promptStore = new PromptLayerStore(
    resolvePromptLayersPath(dataDir),
    resolvePromptHistoryPath(dataDir),
    {
      ...(options.invalidatePromptCache ? { onMutation: options.invalidatePromptCache } : {}),
    },
  );
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const northStarStore = new NorthStarStore(resolveNorthStarPath(dataDir));
  promptStore.seedFromCharacterCard(baseSystemPrompt);
  ensureTemporalRulesPromptLayer(promptStore);
  ensureRuntimePromptLayers(promptStore);
  ensureSystemLanguagePromptLayer(promptStore);
  installSystemLanguagePromptLayerSource(promptStore);

  target.promptComposer = new PromptComposer(
    promptStore,
    undefined,
    resolvePromptLastKnownGoodPath(dataDir),
    {
      enableConstitution: true,
      companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
      northStarLayerProvider: () => northStarStore.buildPromptLayer(),
    },
  );
  target.registerTool(createIdentityTool(promptStore, options), 'core');
  target.registerTool(createNorthStarTool(northStarStore), 'extended');

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
}

export function wireCharacterCardRuntime(
  _target: CharacterCardRuntimeTarget,
  cardStore: CharacterCardVersionStore,
  _options: { confirmationQueue?: unknown; getCapabilityTier?: () => CapabilityTier } = {},
): void {
  const snapshot = cardStore.getCurrent();
  log.info(`Persona tooling enabled (v${snapshot.version})`);
}

/**
 * Wire static prompt registry used by runtime LLM call-sites
 * (extraction, compaction summary, and other keyed prompts).
 */
export function wireStaticPromptRegistry(
  dataDir: string,
  options: PromptCacheInvalidationOptions = {},
): PromptRegistryStore {
  const promptRegistry = new PromptRegistryStore(
    resolvePromptRegistryPath(dataDir),
    resolvePromptRegistryHistoryPath(dataDir),
    {
      ...(options.invalidatePromptCache ? { onMutation: options.invalidatePromptCache } : {}),
    },
  );
  log.info(`Static prompt registry enabled (${promptRegistry.list().length} prompts)`);
  return promptRegistry;
}

/**
 * Build REPL config with runtime settings overrides.
 * Shared across the split runtime entrypoints to keep analysis workbench budgets aligned.
 */
export function buildReplConfig(config: SubstrateConfig): REPLConfig {
  const replConfig: REPLConfig = {
    ...DEFAULT_REPL_CONFIG,
    budget: { ...DEFAULT_REPL_CONFIG.budget },
  };
  if (config.analysisWorkbenchMaxTokens !== undefined) replConfig.budget.maxTokens = config.analysisWorkbenchMaxTokens;
  if (config.analysisWorkbenchMaxWallTimeMs !== undefined) replConfig.budget.maxWallTimeMs = config.analysisWorkbenchMaxWallTimeMs;
  if (config.analysisWorkbenchDirectResponseTimeoutMs !== undefined) {
    replConfig.directResponseTimeoutMs = validateAnalysisWorkbenchDirectResponseTimeoutMs(
      config.analysisWorkbenchDirectResponseTimeoutMs,
    );
  }
  if (config.analysisWorkbenchMaxSubQueries !== undefined) replConfig.budget.maxSubQueries = config.analysisWorkbenchMaxSubQueries;
  if (config.analysisWorkbenchMaxIterations !== undefined) {
    const maxIterations = config.analysisWorkbenchMaxIterations;
    replConfig.budget.maxIterations = maxIterations;
    // Lift every tier ceiling so the loop's Math.min(base, tier.maxIterations)
    // clamp honors the operator's explicit value. Copy per tier: DEFAULT_REPL_CONFIG
    // shares its tierBudgets object, so in-place mutation would leak globally.
    const liftTierCeiling = (tier: TierAnalysisWorkbenchBudget): TierAnalysisWorkbenchBudget => ({
      ...tier,
      maxIterations: Math.max(tier.maxIterations, maxIterations),
    });
    replConfig.tierBudgets = {
      nursery: liftTierCeiling(replConfig.tierBudgets.nursery),
      apprentice: liftTierCeiling(replConfig.tierBudgets.apprentice),
      autonomous: liftTierCeiling(replConfig.tierBudgets.autonomous),
    };
  }
  if (config.analysisWorkbenchExecutionTimeoutMs !== undefined) replConfig.executionTimeoutMs = config.analysisWorkbenchExecutionTimeoutMs;
  if (config.analysisWorkbenchOutputTruncation !== undefined) replConfig.outputTruncation = config.analysisWorkbenchOutputTruncation;
  return replConfig;
}

/**
 * Wire runtime settings introspection tool (read-only).
 * Shared across the split runtime entrypoints.
 */
export function wireSettingsRuntime(
  target: ToolRegistrarTarget,
  config: SubstrateConfig,
  options: {
    registerSystemTool?: boolean;
  } = {},
): void {
  if (options.registerSystemTool !== false) {
    target.registerTool(createSystemTool(config), 'core');
  }
}

export function wireSessionToolsRuntime(
  target: ToolRegistrarTarget,
  sessionManager: SessionManager,
  dataDir: string,
  llmProvider: LLMProviderPort,
  promptRegistry: PromptRegistryStatePort | null = null,
): void {
  target.registerTool(createSessionTool({
    manager: sessionManager,
    llmProvider,
    promptRegistry,
    sessionsDir: resolveSessionsDir(dataDir),
    dataDir,
    setActiveSession: (sessionId) => sessionManager.setActiveContextSession(sessionId),
    seedSession: (sessionId) => {
      sessionManager.initializeExplicitSession(
        sessionId,
        'Session initialized via session action=new.',
      );
    },
  }), 'core');
}

export function wireFilesystemToolsRuntime(
  target: FilesystemToolRuntimeTarget,
  workspacePath: string,
  config: Pick<SubstrateConfig, 'fsReadMaxBytes'> = {},
): void {
  wireFilesystemRuntime(target, workspacePath, {
    ...(config.fsReadMaxBytes !== undefined
      ? { defaultReadMaxBytes: config.fsReadMaxBytes }
      : {}),
  });
}

/**
 * Wire the multi-template reflection system.
 *
 * Keep this startup composition path delegated to the canonical scheduler
 * runtime. The older inline implementation diverged from
 * `core/scheduler/reflection-template-runtime`, which meant production
 * scheduled reflections missed memory/contact provenance even though the
 * standalone runtime tests passed.
 */
export async function wireReflectionRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: ReflectionAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: ReflectionRuntimeOptions = {},
): Promise<void> {
  await wireCoreReflectionRuntime(
    target,
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions,
  );
}
