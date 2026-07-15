import type { Scheduler } from '../../scheduler/scheduler.js';
import type { SubstrateAgent } from '../substrate-agent.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import type { ModelUsageQueryPort } from '../../../shared/telemetry/model-usage.js';
import type { ToolUsageEvaluatorConfig } from '../../../system/config/scheduler-config.js';
import {
  createToolUsageEvaluator,
  type ToolUsageEvaluatorEvent,
} from './usage-evaluator.js';

export const TOOL_USAGE_EVALUATOR_TASK_ID = 'tool_usage.evaluator';

/**
 * Register the durable tool-usage evaluator lane (psfn-framework-b0yl.5).
 *
 * Opt-in and fail-closed: the task is registered only when the config enables it,
 * matching the introspection-audit lane. When it runs it reads durable per-tool
 * aggregates from `model_usage_events`, refreshes presentation ordering, and
 * surfaces operator-visible pin suggestions through the autonomous-action memory
 * path. It never gates callability and never applies a pin silently.
 */
export function registerToolUsageEvaluatorTask(options: {
  scheduler: Scheduler;
  agent: SubstrateAgent;
  getModelUsageQuery: () => ModelUsageQueryPort | null;
  getMemoryWriter: () => Pick<MemoryWriter, 'write'> | undefined;
  config: ToolUsageEvaluatorConfig;
  onEvent?: (event: ToolUsageEvaluatorEvent) => void;
  skipFirstRun?: boolean;
}): void {
  if (!options.config.enabled || options.scheduler.getTask(TOOL_USAGE_EVALUATOR_TASK_ID)) return;

  const evaluator = createToolUsageEvaluator({
    getModelUsageQuery: options.getModelUsageQuery,
    getExtendedToolNames: () => options.agent.getToolCatalog().extended.map(tool => tool.name),
    getPromotedExtendedTools: () => options.agent.getPromotedExtendedTools(),
    getPromotedExtendedToolsLimit: () => options.agent.getPromotedExtendedToolsLimit(),
    applyRanking: ranking => options.agent.setToolUsageRanking(ranking),
    getMemoryWriter: options.getMemoryWriter,
    usageWindow: options.config.usageWindow,
    minPinSuggestionInvocations: options.config.minPinSuggestionInvocations,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  options.scheduler.register(
    {
      id: TOOL_USAGE_EVALUATOR_TASK_ID,
      name: 'Tool Usage Evaluator',
      type: 'every',
      intervalMs: options.config.intervalMs,
      handler: async () => {
        await evaluator.evaluate();
      },
      // The suggestion side writes autonomous-action memories; require the
      // memory.write token so the whole lane is gated honestly.
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
