import type { Scheduler } from '../../scheduler/scheduler.js';
import type { SubstrateAgent } from '../substrate-agent.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import type { TurnRecordUsageRecord } from '../../../persistence/sessions/turn-record-store-port.js';
import type { ToolUsageEvaluatorConfig } from '../../../system/config/scheduler-config.js';
import {
  createToolUsageEvaluator,
  type ToolUsageEvaluatorEvent,
} from './usage-evaluator.js';
import {
  createTurnRecordToolUsageSource,
  type ToolUsageAggregateSource,
} from './turn-record-usage-source.js';

export const TOOL_USAGE_EVALUATOR_TASK_ID = 'tool_usage.evaluator';

/**
 * Durable turn-record accessors the evaluator aggregates over. Reads only; the
 * lane never mutates the turn-record stream. `null` disables the lane's source
 * (fail-closed skip) when no session store is available.
 */
export interface ToolUsageTurnRecordAccess {
  /** Logical-session/channel keys for this companion. */
  listChannelKeys: () => readonly string[];
  /** Tombstone-aware newest-first read of a channel's turn records. */
  readRecentTurnRecords: (channelKey: string, limit: number) => readonly TurnRecordUsageRecord[];
}

/**
 * Register the durable tool-usage evaluator lane (psfn-framework-b0yl.5).
 *
 * Opt-in and fail-closed: the task is registered only when the config enables it,
 * matching the introspection-audit lane. When it runs it aggregates ACTUAL
 * per-tool invocations from the durable turn-record stream (every catalog tool,
 * not just tool-internal LLM calls), refreshes presentation ordering, and
 * surfaces operator-visible pin suggestions through the autonomous-action memory
 * path. It never gates callability and never applies a pin silently.
 */
export function registerToolUsageEvaluatorTask(options: {
  scheduler: Scheduler;
  agent: SubstrateAgent;
  turnRecordAccess: ToolUsageTurnRecordAccess | null;
  getMemoryWriter: () => Pick<MemoryWriter, 'write'> | undefined;
  config: ToolUsageEvaluatorConfig;
  onEvent?: (event: ToolUsageEvaluatorEvent) => void;
  skipFirstRun?: boolean;
}): void {
  if (!options.config.enabled || options.scheduler.getTask(TOOL_USAGE_EVALUATOR_TASK_ID)) return;

  const access = options.turnRecordAccess;
  const source: ToolUsageAggregateSource | null = access
    ? createTurnRecordToolUsageSource({
      listChannelKeys: access.listChannelKeys,
      readRecentTurnRecords: access.readRecentTurnRecords,
      usageWindow: options.config.usageWindow,
    })
    : null;

  const evaluator = createToolUsageEvaluator({
    getUsageAggregateSource: () => source,
    getExtendedToolNames: () => options.agent.getToolCatalog().extended.map(tool => tool.name),
    getCatalogToolCount: () => {
      const catalog = options.agent.getToolCatalog();
      return catalog.core.length + catalog.extended.length;
    },
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
