// ── Shared Runtime Wiring ──
// Common primitives used by both single-process runtime and gateway agent mode.

import { join } from 'node:path';
import type { SubstrateConfig } from '../types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import type { LLMProvider } from '../agent/contracts.js';
import { createSettingsGetTool } from '../settings-tools.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import { PromptComposer } from '../identity/prompt-composer.js';
import { PromptRegistryStore } from '../identity/prompt-registry.js';
import { runDeliberation } from '../llm/deliberation.js';
import type { DeliberationResult } from '../llm/deliberation.js';
import {
  createCharacterCardUpdateTool,
  type CharacterCardUpdateToolOptions,
  type CharacterCardVersionStore,
} from '../identity/card-versioning.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createIdentityDiffTool,
  createIdentityChangelogTool,
  createPromptLayerUpdateTool,
  createPromptLayerToggleTool,
  type PromptLayerUpdateToolOptions,
} from '../identity/prompt-tools.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import {
  createHeartbeatGetPolicyTool,
  createHeartbeatRunTemplateTool,
  createHeartbeatUpdatePolicyTool,
  createScheduleTaskTool,
} from '../scheduler/heartbeat-tools.js';
import type { ReflectionTemplate } from '../scheduler/heartbeat-policy.js';
import type { SessionManager } from '../session/manager.js';
import type { MemoryWriter } from '../memory/writer.js';
import { ValuesJournalStore } from '../values/store.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';

const log = createComponentLogger('SharedWiring');

interface HeartbeatAgent {
  handleMessage(message: {
    id: string;
    channelId: string;
    channelType: 'terminal';
    authorId: string;
    authorName: string;
    content: string;
    timestamp: Date;
  }): Promise<{ content: string }>;
  waitForIdle?(): Promise<void>;
}

interface HeartbeatRuntimeOptions {
  llmProvider?: LLMProvider;
  sessionManager?: Pick<SessionManager, 'recordAssistantMessage' | 'appendSystemNote'>;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
}

export interface PromptRuntimeTarget extends ToolRegistrarTarget {
  promptComposer: PromptComposer | null;
}

export type CharacterCardRuntimeTarget = ToolRegistrarTarget;

/**
 * Wire prompt stack storage, composition, and tools.
 * Shared across runtime.ts and agent-main.ts to keep behavior in sync.
 */
export function wirePromptRuntime(
  target: PromptRuntimeTarget,
  dataDir: string,
  baseSystemPrompt: string,
  options: PromptLayerUpdateToolOptions = {},
): PromptLayerStore {
  const promptStore = new PromptLayerStore(
    join(dataDir, 'prompt-layers.json'),
    join(dataDir, 'prompt-history.jsonl'),
  );
  promptStore.seedFromCharacterCard(baseSystemPrompt);

  target.promptComposer = new PromptComposer(promptStore);
  target.registerTool(createPromptLayerListTool(promptStore), 'extended');
  target.registerTool(createPromptLayerGetTool(promptStore), 'extended');
  target.registerTool(createIdentityDiffTool(promptStore), 'extended');
  target.registerTool(createIdentityChangelogTool(promptStore), 'extended');
  target.registerTool(createPromptLayerUpdateTool(promptStore, options), 'extended');
  target.registerTool(createPromptLayerToggleTool(promptStore), 'extended');

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
}

export function wireCharacterCardRuntime(
  target: CharacterCardRuntimeTarget,
  cardStore: CharacterCardVersionStore,
  options: CharacterCardUpdateToolOptions = {},
): void {
  target.registerTool(createCharacterCardUpdateTool(cardStore, options), 'extended');
  const snapshot = cardStore.getCurrent();
  log.info(`Character card tooling enabled (v${snapshot.version})`);
}

/**
 * Wire static prompt registry used by runtime LLM call-sites
 * (extraction, compaction summary, and other keyed prompts).
 */
export function wireStaticPromptRegistry(dataDir: string): PromptRegistryStore {
  const promptRegistry = new PromptRegistryStore(
    join(dataDir, 'prompt-registry.json'),
    join(dataDir, 'prompt-registry-history.jsonl'),
  );
  log.info(`Static prompt registry enabled (${promptRegistry.list().length} prompts)`);
  return promptRegistry;
}

/**
 * Build REPL config with runtime settings overrides.
 * Shared across runtime.ts and agent-main.ts to keep think tool budgets aligned.
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
 * Wire runtime settings introspection tool (read-only).
 * Shared across runtime.ts and agent-main.ts.
 */
export function wireSettingsRuntime(
  target: ToolRegistrarTarget,
  config: SubstrateConfig,
): void {
  target.registerTool(createSettingsGetTool(config), 'extended');
}

/**
 * Wire the multi-template heartbeat/reflection system.
 * Registers policy-driven reflection tasks and agent tools for managing them.
 */
export function wireHeartbeatRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: HeartbeatRuntimeOptions = {},
): void {
  const DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
  const MIN_SCHEDULED_TEMPLATE_GAP_MS = 60_000;
  const store = new HeartbeatPolicyStore(join(dataDir, 'heartbeat-policy.json'));
  const valuesJournal = new ValuesJournalStore(join(dataDir, 'values.jsonl'));
  const policy = store.load();
  const pendingDeferredTemplates = new Set<string>();
  const lastScheduledRunAt = new Map<string, number>();

  const isBusyReflectionError = (error: unknown): boolean => {
    const text = String(error ?? '').toLowerCase();
    return text.includes('already processing')
      || text.includes('agent_busy')
      || text.includes('channel_busy');
  };

  const toDeliberationMetadata = (
    result: DeliberationResult,
  ): ValuesDeliberationMetadata => ({
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    rounds: result.rounds.length,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    totalTokens: result.totalTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
  });

  const persistDeliberationJournalEntry = (
    reflectionChannelId: string,
    reflection: string,
    metadata: ValuesDeliberationMetadata,
  ): void => {
    if (!runtimeOptions.sessionManager) return;
    runtimeOptions.sessionManager.recordAssistantMessage(
      reflectionChannelId,
      reflection,
      undefined,
      false,
      undefined,
      {
        trustLevel: 'trusted',
        mirror: false,
      },
    );
    runtimeOptions.sessionManager.appendSystemNote(
      reflectionChannelId,
      `[Deliberation metadata] ${JSON.stringify(metadata)}`,
    );
  };

  const persistDeliberationMemory = async (
    template: ReflectionTemplate,
    reflection: string,
    metadata: ValuesDeliberationMetadata,
  ): Promise<void> => {
    if (!runtimeOptions.memoryWriter) return;
    await runtimeOptions.memoryWriter.write({
      text: reflection,
      type: 'reflection',
      importance: 0.72,
      confidence: 0.78,
      emotionalValence: 0,
      sourceRef:
        `source:heartbeat|template:${template.id}|mode:deliberation`
        + `|session:${metadata.sessionId}|tokens:${metadata.totalTokens}`
        + `|cost_usd:${metadata.estimatedCostUsd.toFixed(6)}`,
      tags: [
        'heartbeat',
        'reflection',
        'deliberation',
        template.id,
        `stop:${metadata.stopReason}`,
      ],
    });
  };

  const shouldUseDeliberation = (template: ReflectionTemplate): boolean => {
    if (template.mode !== 'deliberation') return false;
    return Boolean(runtimeOptions.llmProvider);
  };

  const runTemplateDeliberation = async (
    template: ReflectionTemplate,
  ): Promise<{ reflection: string; metadata: ValuesDeliberationMetadata }> => {
    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Deliberation mode requested without llmProvider');
    }
    const result = await runDeliberation(
      llmProvider,
      template.prompt,
      {
        ...(template.deliberation?.voices ? { voices: template.deliberation.voices } : {}),
        caps: {
          ...(template.deliberation?.maxRounds !== undefined
            ? { maxRounds: template.deliberation.maxRounds }
            : {}),
          ...(template.deliberation?.maxTotalTokens !== undefined
            ? { maxTotalTokens: template.deliberation.maxTotalTokens }
            : {}),
          ...(template.deliberation?.maxWallTimeMs !== undefined
            ? { maxWallTimeMs: template.deliberation.maxWallTimeMs }
            : {}),
        },
        cost: {
          ...(template.deliberation?.inputUsdPerMillionTokens !== undefined
            ? { inputUsdPerMillionTokens: template.deliberation.inputUsdPerMillionTokens }
            : {}),
          ...(template.deliberation?.outputUsdPerMillionTokens !== undefined
            ? { outputUsdPerMillionTokens: template.deliberation.outputUsdPerMillionTokens }
            : {}),
        },
      },
    );
    return {
      reflection: result.output,
      metadata: toDeliberationMetadata(result),
    };
  };

  const executeTemplate = async (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
  ): Promise<{ templateId: string; templateName: string; reflection: string }> => {
    const reflectionChannelId = `internal:reflection:${template.id}`;
    let reflectionText = '';
    let deliberationMetadata: ValuesDeliberationMetadata | undefined;

    if (shouldUseDeliberation(template)) {
      const deliberationResult = await runTemplateDeliberation(template);
      reflectionText = deliberationResult.reflection;
      deliberationMetadata = deliberationResult.metadata;
      try {
        persistDeliberationJournalEntry(
          reflectionChannelId,
          reflectionText,
          deliberationMetadata,
        );
      } catch (error) {
        log.warn(`Reflection "${template.id}" journal persistence skipped`, {
          error: String(error),
        });
      }
      try {
        await persistDeliberationMemory(template, reflectionText, deliberationMetadata);
      } catch (error) {
        log.warn(`Reflection "${template.id}" memory persistence skipped`, {
          error: String(error),
        });
      }
    } else {
      const response = await agentLoop.handleMessage({
        id: `reflection-${template.id}-${Date.now()}`,
        channelId: reflectionChannelId,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: template.name,
        content: template.prompt,
        timestamp: new Date(),
      });
      reflectionText = response.content;
    }

    if (template.id === 'values-reflection') {
      valuesJournal.append({
        templateId: template.id,
        templateName: template.name,
        prompt: template.prompt,
        reflection: reflectionText,
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
      });
    }

    const shouldSendToDiscord = options.sendToDiscordOverride ?? template.sendToDiscord;
    if (shouldSendToDiscord && heartbeatChannelId) {
      await sender.send(heartbeatChannelId, reflectionText);
    }

    return {
      templateId: template.id,
      templateName: template.name,
      reflection: reflectionText,
    };
  };

  const executeScheduledTemplate = async (template: ReflectionTemplate): Promise<void> => {
    const now = Date.now();
    const lastRunAt = lastScheduledRunAt.get(template.id);
    if (lastRunAt !== undefined && now - lastRunAt < MIN_SCHEDULED_TEMPLATE_GAP_MS) {
      log.warn(`Skipping reflection "${template.id}" due to rapid re-fire guard`, {
        templateId: template.id,
        sinceLastMs: now - lastRunAt,
      });
      return;
    }
    lastScheduledRunAt.set(template.id, now);
    await executeTemplate(template);
  };

  const queueDeferredTemplateRun = (
    templateId: string,
    options: { sendToDiscordOverride?: boolean } = {},
  ): { templateName: string; queuedNow: boolean } => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    if (pendingDeferredTemplates.has(template.id)) {
      return { templateName: template.name, queuedNow: false };
    }

    pendingDeferredTemplates.add(template.id);
    const taskId = `${DEFERRED_REFLECTION_TASK_PREFIX}${template.id}:${Date.now()}`;
    try {
      scheduler.register({
        id: taskId,
        name: `${template.name} (deferred)`,
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() + 250,
        handler: async () => {
          try {
            await agentLoop.waitForIdle?.();
            const latestPolicy = store.load();
            const latestTemplate = latestPolicy.templates.find(candidate => candidate.id === template.id);
            if (!latestTemplate) {
              log.warn('Skipped deferred reflection; template removed before execution', {
                templateId: template.id,
                taskId,
              });
              return;
            }
            await executeTemplate(latestTemplate, options);
          } catch (error) {
            log.error(`Deferred reflection "${template.id}" failed`, { error: String(error) });
          } finally {
            pendingDeferredTemplates.delete(template.id);
          }
        },
        state: 'idle',
      });
      return { templateName: template.name, queuedNow: true };
    } catch (error) {
      pendingDeferredTemplates.delete(template.id);
      throw error;
    }
  };

  const runTemplateNow = async (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean } = {},
  ): Promise<{ templateId: string; templateName: string; reflection: string; queued?: boolean }> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      return await executeTemplate(template, options);
    } catch (error) {
      if (options.deferIfBusy === false || !isBusyReflectionError(error)) {
        throw error;
      }
      const deferred = queueDeferredTemplateRun(template.id, {
        sendToDiscordOverride: options.sendToDiscordOverride,
      });
      log.info('Deferred manual reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
      return {
        templateId: template.id,
        templateName: deferred.templateName,
        reflection: '',
        queued: true,
      };
    }
  };

  // Create sync function that re-registers all reflection tasks
  const syncReflectionTasks = (): void => {
    // Unregister all existing reflection:* tasks
    for (const task of scheduler.listTasks()) {
      if (task.id.startsWith('reflection:') && !task.id.startsWith(DEFERRED_REFLECTION_TASK_PREFIX)) {
        scheduler.unregister(task.id);
      }
    }

    // Re-register from current policy
    const current = store.load();
    for (const template of current.templates) {
      if (!template.enabled) continue;
      scheduler.register(
        {
          id: `reflection:${template.id}`,
          name: template.name,
          type: 'every',
          intervalMs: template.intervalMs,
          handler: async () => {
            try {
              await executeScheduledTemplate(template);
            } catch (err) {
              log.error(`Reflection "${template.id}" error`, { error: String(err) });
            }
          },
          state: 'idle',
        },
        { skipFirstRun: true },
      );
    }

    const activeCount = current.templates.filter(t => t.enabled).length;
    log.info(`Synced ${activeCount} reflection tasks`);
  };

  // Initial sync
  syncReflectionTasks();

  // Register tools
  target.registerTool(createHeartbeatGetPolicyTool(store), 'extended');
  target.registerTool(createHeartbeatUpdatePolicyTool(store, syncReflectionTasks), 'extended');
  target.registerTool(createHeartbeatRunTemplateTool(store, runTemplateNow), 'extended');
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId), 'extended');

  const activeCount = policy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${policy.templates.length} templates, ${activeCount} active)`);
}
