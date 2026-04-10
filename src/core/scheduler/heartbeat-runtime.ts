import { createComponentLogger } from '../../shared/logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from './scheduler.js';
import {
  createHeartbeatGetPolicyTool,
  createHeartbeatRunTemplateTool,
  createHeartbeatUpdatePolicyTool,
  createScheduleTaskTool,
} from './heartbeat-tools.js';
import { createScheduleTool } from './schedule-tool.js';
import {
  createValuesAddTool,
  createValuesListTool,
  createValuesUpdateTool,
} from '../../faculties/values/tools.js';
import { createLegacyAliasTelemetryEmitter } from '../tools/legacy-alias-telemetry.js';
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

  target.registerTool(createHeartbeatGetPolicyTool(templateRuntime.policyStore), 'core');
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
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(runtimeOptions.eventBus),
  }), 'core');
  target.registerTool(createHeartbeatUpdatePolicyTool(templateRuntime.policyStore, templateRuntime.syncReflectionTasks, {
    memoryWriter: runtimeOptions.memoryWriter,
    reflectionStore: runtimeOptions.reflectionStore,
  }), 'extended');
  target.registerTool(createHeartbeatRunTemplateTool(templateRuntime.policyStore, templateRuntime.runTemplateNow), 'extended');
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId), 'extended');
  target.registerTool(createValuesListTool(templateRuntime.valuesJournal), 'core');
  target.registerTool(createValuesAddTool(templateRuntime.valuesJournal), 'extended');
  target.registerTool(createValuesUpdateTool(templateRuntime.valuesJournal), 'extended');

  const activeCount = templateRuntime.initialPolicy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${templateRuntime.initialPolicy.templates.length} templates, ${activeCount} active)`);
}
