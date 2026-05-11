import { createComponentLogger } from '../../shared/logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from './scheduler.js';
import { createScheduleTool } from './schedule-tool.js';
import {
  createValuesAddTool,
  createValuesUpdateTool,
} from '../../faculties/values/tools.js';
import {
  createHeartbeatTemplateRuntime,
  type HeartbeatTemplateRuntime,
} from './heartbeat-template-runtime.js';
import { wireHeartbeatPostTurnRuntime } from './heartbeat-post-turn-runtime.js';
import {
  type HeartbeatAgent,
  type HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';
export {
  DEFERRED_HEARTBEAT_ACTION_KIND,
} from './heartbeat-runtime-contracts.js';
export type {
  HeartbeatAgent,
  HeartbeatRunTemplateResult,
  HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';

const log = createComponentLogger('HeartbeatRuntime');

export function wireHeartbeatRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: HeartbeatRuntimeOptions = {},
): void {
  const templateRuntime: HeartbeatTemplateRuntime = createHeartbeatTemplateRuntime({
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions,
  });

  wireHeartbeatPostTurnRuntime({
    agentLoop,
    sender,
    templateRuntime,
    runtimeOptions,
  });

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
  }), 'core');
  target.registerTool(createValuesAddTool(templateRuntime.valuesJournal), 'extended');
  target.registerTool(createValuesUpdateTool(templateRuntime.valuesJournal), 'extended');

  const activeCount = templateRuntime.initialPolicy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${templateRuntime.initialPolicy.templates.length} templates, ${activeCount} active)`);
}
