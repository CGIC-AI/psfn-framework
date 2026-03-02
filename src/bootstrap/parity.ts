// ── Shared Runtime Wiring ──
// Common primitives used by both single-process runtime and gateway agent mode.

import { join } from 'node:path';
import type { PostTurnActionCandidate, SubstrateConfig } from '../types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import type { LLMProvider } from '../agent/contracts.js';
import { createSettingsGetTool } from '../settings-tools.js';
import type { SessionManager } from '../session/manager.js';
import { createSessionListTool, createSessionNewTool, createSessionResumeTool } from '../tools/session.js';
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
import type { MemoryWriter } from '../memory/writer.js';
import { ValuesJournalStore } from '../values/store.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';
import {
  resolveLegacyValuesJournalPath,
  resolveReflectionJournalPath,
  resolveValuesJournalPath,
} from '../persistence/layout.js';
import { ReflectionJournalStore } from '../notes/reflection-journal.js';
import type { PostTurnActionRuntime } from './post-turn-actions.js';
import { isBusyTurnError } from '../lifecycle/turn-contention.js';

const log = createComponentLogger('SharedWiring');
const HEARTBEAT_RUN_TEMPLATE_TOOL_NAME = 'heartbeat_run_template';
const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';

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
  registerPostTurnActionInferer?(inferer: PostTurnActionInferer): () => void;
}

interface HeartbeatRuntimeOptions {
  llmProvider?: LLMProvider;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
  postTurnActions?: PostTurnActionRuntime;
}

function normalizeDeferredActionCandidate(raw: unknown): PostTurnActionCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim() : '';
  if (!kind) {
    return null;
  }

  const payload = (
    candidate.payload
    && typeof candidate.payload === 'object'
    && !Array.isArray(candidate.payload)
  )
    ? candidate.payload as Record<string, unknown>
    : undefined;
  const dedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
  const normalizedMaxRetries = (
    typeof candidate.maxRetries === 'number'
    && Number.isFinite(candidate.maxRetries)
    && candidate.maxRetries >= 0
  )
    ? Math.floor(candidate.maxRetries)
    : undefined;

  return {
    kind,
    ...(payload ? { payload } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(normalizedMaxRetries !== undefined ? { maxRetries: normalizedMaxRetries } : {}),
  };
}

function extractDeferredActionCandidate(message: unknown): PostTurnActionCandidate | null {
  const stack: unknown[] = [message];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        if (entry && typeof entry === 'object') {
          stack.push(entry);
        }
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const deferredAction = normalizeDeferredActionCandidate(record.deferredAction);
    if (deferredAction) {
      return deferredAction;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

function isHeartbeatRunTemplateToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.role === 'toolResult'
    && candidate.toolName === HEARTBEAT_RUN_TEMPLATE_TOOL_NAME
  );
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

export function wireSessionToolsRuntime(
  target: ToolRegistrarTarget,
  sessionManager: SessionManager,
  dataDir: string,
): void {
  target.registerTool(createSessionNewTool({
    dataDir,
    setActiveSession: (sessionId) => sessionManager.setActiveContextSession(sessionId),
    seedSession: (sessionId) => {
      sessionManager.appendSystemNote(
        sessionId,
        'Session initialized via session_new.',
      );
    },
  }), 'extended');
  target.registerTool(createSessionListTool(sessionManager, { dataDir }), 'extended');
  target.registerTool(createSessionResumeTool(sessionManager, { dataDir }), 'extended');
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
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const reflectionJournal = new ReflectionJournalStore(resolveReflectionJournalPath(dataDir));
  const policy = store.load();
  const pendingDeferredTemplates = new Set<string>();
  const lastScheduledRunAt = new Map<string, number>();

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
    let reflectionMode: 'agent' | 'deliberation' = 'agent';

    if (shouldUseDeliberation(template)) {
      const deliberationResult = await runTemplateDeliberation(template);
      reflectionText = deliberationResult.reflection;
      deliberationMetadata = deliberationResult.metadata;
      reflectionMode = 'deliberation';
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

    try {
      reflectionJournal.append({
        templateId: template.id,
        templateName: template.name,
        prompt: template.prompt,
        reflection: reflectionText,
        channelId: reflectionChannelId,
        mode: reflectionMode,
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
      });
    } catch (error) {
      log.warn(`Reflection "${template.id}" note journal persistence skipped`, {
        error: String(error),
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
    try {
      await executeTemplate(template);
    } catch (error) {
      if (!isBusyTurnError(error)) {
        throw error;
      }
      const deferred = queueDeferredTemplateRun(template.id);
      log.info('Deferred scheduled reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
    }
  };

  const buildDeferredHeartbeatAction = (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
  ): PostTurnActionCandidate => ({
    kind: DEFERRED_HEARTBEAT_ACTION_KIND,
    payload: {
      templateId: template.id,
      ...(options.sendToDiscordOverride !== undefined
        ? { sendToDiscordOverride: options.sendToDiscordOverride }
        : {}),
    },
    dedupeKey: (
      options.sendToDiscordOverride === undefined
        ? `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}`
        : `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}:discord:${String(options.sendToDiscordOverride)}`
    ),
    maxRetries: 2,
  });

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
  ): Promise<{
      templateId: string;
      templateName: string;
      reflection: string;
      queued?: boolean;
      deferredAction?: PostTurnActionCandidate;
    }> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      return await executeTemplate(template, options);
    } catch (error) {
      if (options.deferIfBusy === false || !isBusyTurnError(error)) {
        throw error;
      }
      if (runtimeOptions.postTurnActions) {
        const deferredAction = buildDeferredHeartbeatAction(template, options);
        log.info('Inferred deferred heartbeat action from busy template execution', {
          templateId: template.id,
          dedupeKey: deferredAction.dedupeKey,
        });
        return {
          templateId: template.id,
          templateName: template.name,
          reflection: '',
          queued: true,
          deferredAction,
        };
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
        deferredAction: buildDeferredHeartbeatAction(template, options),
      };
    }
  };

  if (runtimeOptions.postTurnActions) {
    runtimeOptions.postTurnActions.registerHandler(
      DEFERRED_HEARTBEAT_ACTION_KIND,
      async (action) => {
        const templateIdRaw = action.payload.templateId;
        if (typeof templateIdRaw !== 'string' || !templateIdRaw.trim()) {
          throw new Error(`Deferred heartbeat action "${action.id}" is missing payload.templateId`);
        }
        const templateId = templateIdRaw.trim();
        const current = store.load();
        const template = current.templates.find(candidate => candidate.id === templateId);
        if (!template) {
          throw new Error(`Template "${templateId}" not found`);
        }
        const sendToDiscordOverride = typeof action.payload.sendToDiscordOverride === 'boolean'
          ? action.payload.sendToDiscordOverride
          : undefined;
        await executeTemplate(template, {
          ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
        });
      },
    );

    if (agentLoop.registerPostTurnActionInferer) {
      const inferDeferredHeartbeatActions: PostTurnActionInferer = ({ turnMessages }) => {
        const inferred: PostTurnActionCandidate[] = [];
        for (const turnMessage of turnMessages) {
          if (!isHeartbeatRunTemplateToolResult(turnMessage)) continue;
          const candidate = extractDeferredActionCandidate(turnMessage);
          if (!candidate || candidate.kind !== DEFERRED_HEARTBEAT_ACTION_KIND) continue;
          inferred.push(candidate);
        }
        return inferred;
      };
      agentLoop.registerPostTurnActionInferer(inferDeferredHeartbeatActions);
    } else {
      log.warn('Post-turn action runtime enabled but inferer registration is unavailable');
    }
  }

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
