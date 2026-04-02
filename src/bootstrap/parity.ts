// ── Shared Runtime Wiring ──
// Common primitives used by the supported split runtime entrypoints.

import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import { createComponentLogger } from '../logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from '../agent/extended-tool-autoload-policy.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { LLMProvider } from '../agent/contracts.js';
import type { MemoryWriter } from '../memory/writer.js';
import { wireFilesystemRuntime, type FilesystemRuntimeTarget } from '../filesystem/runtime-wiring.js';
import type { SessionManager } from '../session/manager.js';
import { createSessionTool } from '../tools/session.js';
import {
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolvePromptHistoryPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
  resolveSessionsDir,
  resolveValuesJournalPath,
} from '../persistence/layout.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import { PromptComposer } from '../identity/prompt-composer.js';
import { PromptRegistryStore } from '../identity/prompt-registry.js';
import {
  type PersonaUpdateToolOptions,
  type CharacterCardVersionStore,
} from '../identity/card-versioning.js';
import { buildCharacterPromptTemplateVariables } from '../identity/loader.js';
import {
  createIdentityTool,
  type IdentityToolOptions,
} from '../identity/prompt-tools.js';
import { NorthStarStore } from '../north-star/store.js';
import { createNorthStarTool } from '../north-star/tools.js';
import { createLegacyAliasTelemetryEmitter } from '../tools/legacy-alias-telemetry.js';
import { ValuesJournalStore } from '../values/store.js';
import { createSystemTool } from '../tools/lifecycle.js';

const log = createComponentLogger('SharedWiring');

interface ToolsetMemoryWriterTarget extends ToolRegistrarTarget {
  setToolsetMemoryWriter: (getMemoryWriter: () => Pick<MemoryWriter, 'write'> | undefined) => void;
}

function hasToolsetMemoryWriterTarget(
  target: ToolRegistrarTarget,
): target is ToolsetMemoryWriterTarget {
  return typeof (target as Partial<ToolsetMemoryWriterTarget>).setToolsetMemoryWriter === 'function';
}

export interface PromptRuntimeTarget extends ToolRegistrarTarget {
  promptComposer: PromptComposer | null;
}

export type CharacterCardRuntimeTarget = ToolRegistrarTarget;

export function buildCharacterPromptVariablesProvider(
  cardStore: Pick<CharacterCardVersionStore, 'getCurrent'>,
): () => Record<string, string> {
  return () => buildCharacterPromptTemplateVariables(cardStore.getCurrent().card);
}

export interface ExtendedToolAutoloadRuntimeTarget {
  setExtendedToolAutoloadPolicy: (policy: ExtendedToolAutoloadPolicy | null) => void;
}

export type FilesystemToolRuntimeTarget = ToolRegistrarTarget & FilesystemRuntimeTarget;

export function wireExtendedToolAutoloadPolicy(
  target: ExtendedToolAutoloadRuntimeTarget,
  policy: ExtendedToolAutoloadPolicy = createDefaultExtendedToolAutoloadPolicy(),
): void {
  target.setExtendedToolAutoloadPolicy(policy);
}

/**
 * Wire prompt stack storage, composition, and tools.
 * Shared across the supported split entrypoints to keep behavior in sync.
 */
export function wirePromptRuntime(
  target: PromptRuntimeTarget,
  dataDir: string,
  baseSystemPrompt: string,
  options: IdentityToolOptions = {},
): PromptLayerStore {
  const promptLayersPath = resolvePromptLayersPath(dataDir);
  const promptHistoryPath = resolvePromptHistoryPath(dataDir);
  let promptStore: PromptLayerStore;

  try {
    promptStore = new PromptLayerStore(promptLayersPath, promptHistoryPath);
    promptStore.seedFromCharacterCard(baseSystemPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Prompt runtime initialization failed', {
      dataDir,
      promptLayersPath,
      promptHistoryPath,
      error: message,
    });
    throw new Error(`Failed to initialize prompt runtime from ${promptLayersPath}: ${message}`);
  }

  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const northStarStore = new NorthStarStore(resolveNorthStarPath(dataDir));

  target.promptComposer = new PromptComposer(promptStore, undefined, undefined, {
    enableConstitution: true,
    companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    northStarLayerProvider: () => northStarStore.buildPromptLayer(),
  });
  target.registerTool(createIdentityTool(promptStore, options), 'core');
  target.registerTool(createNorthStarTool(northStarStore), 'extended');

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
}

export function wireCharacterCardRuntime(
  _target: CharacterCardRuntimeTarget,
  cardStore: CharacterCardVersionStore,
  _options: PersonaUpdateToolOptions = {},
): void {
  const snapshot = cardStore.getCurrent();
  log.info(`Character-card identity store enabled (v${snapshot.version})`);
}

/**
 * Wire static prompt registry used by runtime LLM call-sites
 * (extraction, compaction summary, and other keyed prompts).
 */
export function wireStaticPromptRegistry(dataDir: string): PromptRegistryStore {
  const promptRegistry = new PromptRegistryStore(
    resolvePromptRegistryPath(dataDir),
    resolvePromptRegistryHistoryPath(dataDir),
  );
  log.info(`Static prompt registry enabled (${promptRegistry.list().length} prompts)`);
  return promptRegistry;
}

/**
 * Build REPL config with runtime settings overrides.
 * Shared across the supported split entrypoints to keep think tool budgets aligned.
 */
export function buildReplConfig(config: SubstrateConfig): REPLConfig {
  const replConfig: REPLConfig = {
    ...DEFAULT_REPL_CONFIG,
    budget: { ...DEFAULT_REPL_CONFIG.budget },
  };
  if (config.thinkMaxTokens !== undefined) replConfig.budget.maxTokens = config.thinkMaxTokens;
  if (config.thinkMaxWallTimeMs !== undefined) replConfig.budget.maxWallTimeMs = config.thinkMaxWallTimeMs;
  if (config.thinkMaxSubQueries !== undefined) replConfig.budget.maxSubQueries = config.thinkMaxSubQueries;
  return replConfig;
}

/**
 * Wire unified system tool with read-only settings access in parity mode.
 * Shared across the supported split entrypoints.
 */
export function wireSettingsRuntime(
  target: ToolRegistrarTarget,
  config: SubstrateConfig,
  options: {
    eventBus?: EventBus;
    getMemoryWriter?: () => Pick<MemoryWriter, 'write'> | undefined;
  } = {},
): void {
  target.registerTool(createSystemTool(config, {
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(options.eventBus),
  }), 'core');
  if (options.getMemoryWriter && hasToolsetMemoryWriterTarget(target)) {
    target.setToolsetMemoryWriter(options.getMemoryWriter);
  }
}

export function wireSessionToolsRuntime(
  target: ToolRegistrarTarget,
  sessionManager: SessionManager,
  dataDir: string,
  llmProvider: LLMProvider,
  eventBus?: EventBus,
): void {
  target.registerTool(createSessionTool({
    manager: sessionManager,
    llmProvider,
    sessionsDir: resolveSessionsDir(dataDir),
    dataDir,
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(eventBus),
    setActiveSession: (sessionId) => sessionManager.setActiveContextSession(sessionId),
    seedSession: (sessionId) => {
      sessionManager.appendSystemNote(
        sessionId,
        'Session initialized via session_new.',
      );
    },
  }), 'core');
}

export function wireFilesystemToolsRuntime(
  target: FilesystemToolRuntimeTarget,
  workspacePath: string,
): void {
  wireFilesystemRuntime(target, workspacePath);
}

export { wireHeartbeatRuntime } from '../scheduler/heartbeat-runtime.js';
