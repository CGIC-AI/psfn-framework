// ── Weighted-thought outreach scheduler lane (Charter 6.24, bead 1xb.2) ──
//
// Rides the existing scheduler (no new polling loop). On each tick it runs the
// deterministic weighted-thought evaluation; only when a thought crosses
// threshold does the LLM nudge fire. Accepted nudges are emitted as
// INTENTION_OUTBOUND_MESSAGE post-turn actions through the SAME
// 'agent.post_turn.actions.inferred' path the temporal-wakeup / episode-
// synthesis lanes use, so the durable outbox + dispatcher policy gates deliver
// them unchanged. Fires standalone — no inbound message required.

import { createComponentLogger } from '../../shared/logger.js';
import type { EventBus } from '../../shared/event-bus.js';
import { toInferredPostTurnActions } from '../intention/appraisal/action-translation.js';
import type { ProactiveQuietHoursConfig } from '../intention/proactive-time-gate.js';
import type { WeightedThoughtStorePort } from '../intention/weighted-thought-store-port.js';
import {
  runWeightedThoughtOutreachOnce,
  type NudgeEvaluator,
  type OutreachChannelPolicy,
} from '../intention/weighted-thought-outreach.js';
import type { WeightedThoughtOutreachConfig } from '../../system/config/scheduler-config.js';
import type { Scheduler } from './scheduler.js';

const log = createComponentLogger('WeightedThoughtOutreach');

export const WEIGHTED_THOUGHT_OUTREACH_TASK_ID = 'weighted_thought.outreach';
const WEIGHTED_THOUGHT_OUTREACH_TASK_NAME = 'Weighted-Thought Outreach Trigger';

export interface WeightedThoughtOutreachTaskOptions {
  scheduler: Scheduler;
  eventBus: EventBus;
  config: WeightedThoughtOutreachConfig;
  /** Quiet-hours / rest window for outward delivery timing (episodicProcessing). */
  quietHours?: ProactiveQuietHoursConfig | null;
  store: WeightedThoughtStorePort;
  nudgeEvaluator: NudgeEvaluator;
  channelPolicy: OutreachChannelPolicy;
  contactId?: string;
  now?: () => number;
}

/**
 * Register the standalone weighted-thought outreach trigger. Disabled unless
 * scheduler.json weightedThoughtOutreach.enabled is true (fail-closed): with no
 * companion-initiated outreach configured, the lane is never registered.
 */
export function registerWeightedThoughtOutreachTask(
  options: WeightedThoughtOutreachTaskOptions,
): void {
  if (!options.config.enabled) {
    log.info('Weighted-thought outreach lane disabled by scheduler.json weightedThoughtOutreach.enabled');
    return;
  }
  if (options.scheduler.getTask(WEIGHTED_THOUGHT_OUTREACH_TASK_ID)) {
    return;
  }

  const resolveNow = options.now ?? (() => Date.now());

  options.scheduler.register(
    {
      id: WEIGHTED_THOUGHT_OUTREACH_TASK_ID,
      name: WEIGHTED_THOUGHT_OUTREACH_TASK_NAME,
      type: 'every',
      intervalMs: Math.max(1_000, options.config.checkIntervalMs),
      handler: async () => {
        await runWeightedThoughtOutreachTick(options, resolveNow());
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    },
    { skipFirstRun: true },
  );
}

async function safeEmit(
  eventBus: EventBus,
  emit: () => Promise<void>,
): Promise<void> {
  try {
    await emit();
  } catch (error) {
    // Telemetry emission must never undo the persisted lifecycle state.
    log.warn('Weighted-thought outreach event emit failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void eventBus;
}

export async function runWeightedThoughtOutreachTick(
  options: WeightedThoughtOutreachTaskOptions,
  nowMs: number,
): Promise<void> {
  const { eventBus, config } = options;
  const result = await runWeightedThoughtOutreachOnce(
    {
      store: options.store,
      lifecycleConfig: config.lifecycle,
      nudgeThreshold: config.nudgeThreshold,
      maxNudgesPerRun: config.maxNudgesPerRun,
      quietHours: options.quietHours ?? null,
      channelPolicy: options.channelPolicy,
      nudgeEvaluator: options.nudgeEvaluator,
      ...(options.contactId ? { contactId: options.contactId } : {}),
    },
    nowMs,
  );

  await safeEmit(eventBus, () => eventBus.emit('intention.nudge.gate', {
    open: result.gate.open,
    reason: result.gate.reason,
    maxWeight: typeof result.gate.inputs.maxWeight === 'number' ? result.gate.inputs.maxWeight : 0,
    threshold: config.nudgeThreshold,
    thoughtCount: typeof result.gate.inputs.thoughtCount === 'number' ? result.gate.inputs.thoughtCount : 0,
    timestamp: nowMs,
  }));

  if (!result.evaluated) {
    return;
  }

  for (const produced of result.produced) {
    await safeEmit(eventBus, () => eventBus.emit('intention.nudge.produced', {
      thoughtId: produced.thoughtId,
      thoughtClass: produced.thoughtClass,
      weight: produced.weight,
      channelId: produced.channelId,
      channelType: produced.channelType,
      target: produced.target,
      timestamp: nowMs,
    }));

    const syntheticMessage = {
      id: `weighted-thought-outreach:${produced.thoughtId}:${nowMs}`,
      channelId: produced.channelId,
      channelType: produced.channelType,
      authorId: 'system:weighted-thought-outreach',
      authorName: 'Weighted Thought',
      content: 'Weighted-thought outreach nudge accepted.',
      timestamp: new Date(nowMs),
    };
    await safeEmit(eventBus, () => eventBus.emit('agent.post_turn.actions.inferred', {
      message: syntheticMessage,
      response: {
        content: '',
        channelId: produced.channelId,
        metadata: {
          model: 'scheduler:weighted-thought-outreach',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        },
      },
      actions: toInferredPostTurnActions([produced.candidate], syntheticMessage),
    }));

    await safeEmit(eventBus, () => eventBus.emit('intention.nudge.accepted', {
      thoughtId: produced.thoughtId,
      channelId: produced.channelId,
      channelType: produced.channelType,
      target: produced.target,
      timestamp: nowMs,
    }));
    log.info('Weighted-thought outreach nudge accepted and enqueued', {
      thoughtId: produced.thoughtId,
      target: produced.target,
      channelId: produced.channelId,
    });
  }

  for (const declined of result.declined) {
    await safeEmit(eventBus, () => eventBus.emit('intention.nudge.declined', {
      thoughtId: declined.thoughtId,
      ...(declined.reason ? { reason: declined.reason } : {}),
      dampenedWeight: declined.dampenedWeight,
      timestamp: nowMs,
    }));
  }

  for (const blocked of result.blocked) {
    await safeEmit(eventBus, () => eventBus.emit('intention.nudge.blocked', {
      thoughtId: blocked.thoughtId,
      reason: blocked.reason,
      ...(blocked.channelId ? { channelId: blocked.channelId } : {}),
      timestamp: nowMs,
    }));
  }

  for (const deferred of result.deferred) {
    await safeEmit(eventBus, () => eventBus.emit('intention.nudge.blocked', {
      thoughtId: deferred.thoughtId,
      reason: deferred.reason,
      nextEligibleAtMs: deferred.nextEligibleAtMs,
      timestamp: nowMs,
    }));
  }
}
