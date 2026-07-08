import { createComponentLogger } from '../../shared/logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from './scheduler.js';
import { createScheduleTool } from './schedule-tool.js';
import {
  createHeartbeatTemplateRuntime,
  type HeartbeatTemplateRuntime,
} from './heartbeat-template-runtime.js';
import { wireHeartbeatPostTurnRuntime } from './heartbeat-post-turn-runtime.js';
import {
  type HeartbeatAgent,
  type HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';
import { rehydrateScheduledPromptTasks } from './scheduled-prompts.js';
export {
  DEFERRED_HEARTBEAT_ACTION_KIND,
} from './heartbeat-runtime-contracts.js';
export type {
  HeartbeatAgent,
  HeartbeatRunTemplateResult,
  HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';

const log = createComponentLogger('HeartbeatRuntime');

export async function wireHeartbeatRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: HeartbeatRuntimeOptions = {},
): Promise<void> {
  const templateRuntime: HeartbeatTemplateRuntime = createHeartbeatTemplateRuntime({
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions,
  });

  wireHeartbeatPostTurnRuntime({
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
    heartbeatPolicyStore: templateRuntime.policyStore,
    syncReflectionTasks: templateRuntime.syncReflectionTasks,
    runTemplate: templateRuntime.runTemplateNow,
    heartbeatChannelId,
    memoryWriter: runtimeOptions.memoryWriter,
    pendingFollowUpStore: runtimeOptions.pendingFollowUpStore ?? null,
    careReminderStore: runtimeOptions.careReminderStore ?? null,
    scheduledPromptStore: runtimeOptions.scheduledPromptStore ?? null,
  }), 'core');

  const activeCount = templateRuntime.initialPolicy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${templateRuntime.initialPolicy.templates.length} templates, ${activeCount} active)`);
}
