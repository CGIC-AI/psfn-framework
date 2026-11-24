// Pure core runtime wiring helpers shared across full-framework entrypoints
// and standalone companion composition (free of host filesystem/REPL wiring).

import type { CapabilityTier, SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { ToolRegistrarTarget } from '../../../core/agent/tool-registrar.js';
import type { MessageSender } from '../../../system/lifecycle/notifications.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { createSessionTool } from '../../../core/tools/session.js';
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
import type { CharacterCardVersionStore } from '../../../core/identity/card-versioning.js';
import { buildCharacterPromptTemplateVariables } from '../../../core/identity/loader.js';
import {
  createIdentityTool,
  type IdentityToolOptions,
} from '../../../core/identity/prompt-tools.js';
import { NorthStarStore } from '../../../faculties/north-star/store.js';
import { createNorthStarTool } from '../../../faculties/north-star/tools.js';
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

/**
 * Wire prompt stack storage, composition, and tools.
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
 * Wire static prompt registry used by runtime LLM call-sites.
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
 * Wire runtime settings introspection tool (read-only).
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

/**
 * Wire the multi-template reflection system.
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
