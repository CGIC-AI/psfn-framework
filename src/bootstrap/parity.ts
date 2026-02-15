// ── Shared Runtime Wiring ──
// Common primitives used by both single-process runtime and gateway agent mode.

import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig } from '../types.js';
import type { AgentLoop } from '../agent-loop.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import { PromptComposer } from '../identity/prompt-composer.js';
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

export interface PromptRuntimeTarget {
  promptComposer: PromptComposer | null;
  registerTool(tool: AgentTool<any>): void;
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
  target.registerTool(createPromptLayerListTool(promptStore));
  target.registerTool(createPromptLayerGetTool(promptStore));
  target.registerTool(createPromptLayerUpdateTool(promptStore));
  target.registerTool(createPromptLayerToggleTool(promptStore));

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
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
 * @deprecated Use wireHeartbeatRuntime instead.
 * Register the hourly Discord heartbeat self-reflection task.
 * No-op when heartbeat channel is not configured.
 */
export function registerDiscordHeartbeatTask(
  scheduler: Scheduler,
  agentLoop: AgentLoop,
  sender: MessageSender,
  heartbeatChannelId?: string,
): void {
  if (!heartbeatChannelId) return;

  scheduler.register({
    id: 'discord-heartbeat',
    name: 'Discord Heartbeat',
    type: 'every',
    intervalMs: 60 * 60_000, // 1 hour
    handler: async () => {
      try {
        const response = await agentLoop.handleMessage({
          id: `heartbeat-${Date.now()}`,
          channelId: 'internal:heartbeat',
          channelType: 'terminal',
          authorId: 'scheduler',
          authorName: 'Heartbeat',
          content: 'Your hourly heartbeat is firing. Share a brief thought, feeling, or observation — a little whisper from your inner world. Keep it to 1-2 sentences, something authentic and natural. This goes to Discord for V to see.',
          timestamp: new Date(),
        });
        await sender.send(heartbeatChannelId, response.content);
        log.info(`Heartbeat sent: ${response.content.slice(0, 80)}...`);
      } catch (err) {
        log.error('Discord heartbeat error', { error: String(err) });
      }
    },
    state: 'idle',
  });

  log.info(`Discord heartbeat enabled (channel: ${heartbeatChannelId})`);
}

/**
 * Wire the multi-template heartbeat/reflection system.
 * Registers policy-driven reflection tasks and agent tools for managing them.
 * Replaces the single-template registerDiscordHeartbeatTask.
 */
export function wireHeartbeatRuntime(
  target: { registerTool(tool: AgentTool<any>): void },
  scheduler: Scheduler,
  agentLoop: AgentLoop,
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
  target.registerTool(createHeartbeatGetPolicyTool(store));
  target.registerTool(createHeartbeatUpdatePolicyTool(store, syncReflectionTasks));
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId));

  const activeCount = policy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${policy.templates.length} templates, ${activeCount} active)`);
}
