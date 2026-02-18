// ── Shared Runtime Wiring ──
// Common primitives used by both single-process runtime and gateway agent mode.

import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig } from '../types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import { createSettingsGetTool } from '../settings-tools.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import { PromptComposer } from '../identity/prompt-composer.js';
import { PromptRegistryStore } from '../identity/prompt-registry.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createPromptLayerUpdateTool,
  createPromptLayerToggleTool,
} from '../identity/prompt-tools.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import {
  createHeartbeatGetPolicyTool,
  createHeartbeatUpdatePolicyTool,
  createScheduleTaskTool,
} from '../scheduler/heartbeat-tools.js';

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
}

export interface PromptRuntimeTarget {
  promptComposer: PromptComposer | null;
  registerTool(tool: AgentTool<any>, category?: 'core' | 'extended'): void;
}

/**
 * Wire prompt stack storage, composition, and tools.
 * Shared across runtime.ts and agent-main.ts to keep behavior in sync.
 */
export function wirePromptRuntime(
  target: PromptRuntimeTarget,
  dataDir: string,
  baseSystemPrompt: string,
): PromptLayerStore {
  const promptStore = new PromptLayerStore(
    join(dataDir, 'prompt-layers.json'),
    join(dataDir, 'prompt-history.jsonl'),
  );
  promptStore.seedFromCharacterCard(baseSystemPrompt);

  target.promptComposer = new PromptComposer(promptStore);
  target.registerTool(createPromptLayerListTool(promptStore), 'extended');
  target.registerTool(createPromptLayerGetTool(promptStore), 'extended');
  target.registerTool(createPromptLayerUpdateTool(promptStore), 'extended');
  target.registerTool(createPromptLayerToggleTool(promptStore), 'extended');

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
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
  target: { registerTool(tool: AgentTool<any>, category?: 'core' | 'extended'): void },
  config: SubstrateConfig,
): void {
  target.registerTool(createSettingsGetTool(config), 'extended');
}

/**
 * Wire the multi-template heartbeat/reflection system.
 * Registers policy-driven reflection tasks and agent tools for managing them.
 */
export function wireHeartbeatRuntime(
  target: { registerTool(tool: AgentTool<any>, category?: 'core' | 'extended'): void },
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
): void {
  const store = new HeartbeatPolicyStore(join(dataDir, 'heartbeat-policy.json'));
  const policy = store.load();

  // Create sync function that re-registers all reflection tasks
  const syncReflectionTasks = (): void => {
    // Unregister all existing reflection:* tasks
    for (const task of scheduler.listTasks()) {
      if (task.id.startsWith('reflection:')) {
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
              const response = await agentLoop.handleMessage({
                id: `reflection-${template.id}-${Date.now()}`,
                channelId: `internal:reflection:${template.id}`,
                channelType: 'terminal',
                authorId: 'scheduler',
                authorName: template.name,
                content: template.prompt,
                timestamp: new Date(),
              });
              if (template.sendToDiscord && heartbeatChannelId) {
                await sender.send(heartbeatChannelId, response.content);
              }
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
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId), 'extended');

  const activeCount = policy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${policy.templates.length} templates, ${activeCount} active)`);
}
