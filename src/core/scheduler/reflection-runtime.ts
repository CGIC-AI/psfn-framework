import { createComponentLogger } from '../../shared/logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from './scheduler.js';
import { createScheduleTool } from './schedule-tool.js';
import {
  createReflectionTemplateRuntime,
  type ReflectionTemplateRuntime,
} from './reflection-template-runtime.js';
import { wirePostTurnRuntime } from './post-turn-runtime.js';
import {
  type ReflectionAgent,
  type ReflectionRuntimeOptions,
} from './reflection-runtime-contracts.js';
import { rehydrateScheduledPromptTasks } from './scheduled-prompts.js';
export {
  DEFERRED_REFLECTION_ACTION_KIND,
} from './reflection-runtime-contracts.js';
export type {
  ReflectionAgent,
  ReflectionRunTemplateResult,
  ReflectionRuntimeOptions,
} from './reflection-runtime-contracts.js';

const log = createComponentLogger('ReflectionRuntime');

export async function wireReflectionRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: ReflectionAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: ReflectionRuntimeOptions = {},
): Promise<void> {
  const templateRuntime: ReflectionTemplateRuntime = createReflectionTemplateRuntime({
    scheduler,
    agentLoop,
    dataDir,
    runtimeOptions,
  });

  wirePostTurnRuntime({
    scheduler,
    agentLoop,
    sender,
    templateRuntime,
    runtimeOptions,
  });

  if (runtimeOptions.scheduledPromptStore) {
    const rehydratedCount = await rehydrateScheduledPromptTasks({
      scheduler,
      agentLoop,
      sender,
      scheduledPromptStore: runtimeOptions.scheduledPromptStore,
      ...(heartbeatChannelId ? { heartbeatChannelId } : {}),
    });
    if (rehydratedCount > 0) {
      log.info('Rehydrated scheduled prompts', { count: rehydratedCount });
    }
  }

  target.registerTool(createScheduleTool({
    scheduler,
    agentLoop,
    sender,
    reflectionPolicyStore: templateRuntime.policyStore,
    syncReflectionTasks: templateRuntime.syncReflectionTasks,
    runTemplate: templateRuntime.runTemplateNow,
    heartbeatChannelId,
    memoryWriter: runtimeOptions.memoryWriter,
    pendingFollowUpStore: runtimeOptions.pendingFollowUpStore ?? null,
    careReminderStore: runtimeOptions.careReminderStore ?? null,
    scheduledPromptStore: runtimeOptions.scheduledPromptStore ?? null,
  }), 'core');

  const activeCount = templateRuntime.initialPolicy.templates.filter(t => t.enabled).length;
  log.info(`Reflection runtime wired (${templateRuntime.initialPolicy.templates.length} templates, ${activeCount} active)`);
}
