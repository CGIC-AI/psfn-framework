import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { RuntimeLaneClass } from '../../../shared/contracts/runtime-lanes.js';
import { AgentRunPreemptedError } from '../../../boundary/pi-agent/agent-loop-patch.js';
import {
  compareRuntimeLanePriority,
  isRuntimeLaneClass,
  resolveRuntimeLaneBudgetProfile,
  resolveRuntimeLaneClassForTurn,
} from '../worker-lanes.js';
import { resolveTurnCallType } from './turn-observability.js';

/**
 * Foreground-over-background preemption of whole agent turns
 * (psfn-framework-z4vhu).
 *
 * The pi-agent loop owns ONE active run, and background reflection turns
 * (sleeptime review, dream pass, heartbeat, deferred continuations) run
 * through the same `handleMessage` path as a person's chat. A chat that
 * arrived while one of them held the run lost the slot and was rejected
 * `agent_busy`; a sleeptime pass that yields and restarts every ~1 s kept
 * foreground chat rejected for minutes. The model-call gate already preempts
 * those lanes' MODEL calls, but a foreground turn never reached its model call.
 *
 * Policy stays single-sourced in the runtime lane profiles (Law 12.4): a turn
 * whose lane is `preemptable` is tracked for its lifetime. A turn of a strictly
 * higher-priority lane, before it touches agent state, marks every tracked
 * lower-priority turn preempted, aborts the active run if it is one of them,
 * and waits for each to settle. A preempted turn that has not reached its run
 * is refused at prompt(). Every preempted turn fails with
 * `AgentRunPreemptedError`, an agent-busy contention that every background
 * owner already treats as a durable defer/yield (the sleeptime workset releases
 * its claim and reschedules; reflection defers on busy). Nothing is dropped.
 * The wait is bounded by the aborted run's settlement and, end to end, by the
 * foreground request's own deadline.
 */

export { AgentRunPreemptedError };

export function resolveTurnRunLaneClass(message: SubstrateMessage): RuntimeLaneClass {
  return resolveRuntimeLaneClassForTurn({
    callType: resolveTurnCallType(message, undefined),
    channelId: message.channelId,
  });
}

/** Whether a run of `incoming` may preempt an active run of `active`. Unknown lanes never preempt. */
export function shouldPreemptAgentRun(
  active: string | undefined,
  incoming: RuntimeLaneClass,
): boolean {
  if (!active || !isRuntimeLaneClass(active)) return false;
  if (!resolveRuntimeLaneBudgetProfile(active).preemptable) return false;
  return compareRuntimeLanePriority(incoming, active) < 0;
}

interface TrackedTurn {
  readonly messageId: string;
  readonly laneClass: RuntimeLaneClass;
  readonly settled: Promise<void>;
  preemptedBy: string | null;
}

export interface TurnPreemptionEvent {
  preemptorMessageId: string;
  preemptorLaneClass: RuntimeLaneClass;
  preemptedMessageId: string;
  preemptedLaneClass: RuntimeLaneClass;
  abortedActiveRun: boolean;
  waitedMs: number;
}

export class BackgroundTurnPreemption {
  private readonly turns = new Map<string, TrackedTurn>();

  constructor(private readonly deps: {
    /** Abort the active agent run if it belongs to a lane `shouldPreempt` accepts. */
    preemptActiveRun: (shouldPreempt: (activeLaneClass: string | undefined) => boolean) => Promise<void> | null;
    /** The message id of the turn owning the current async context, if any. */
    currentTurnMessageId: () => string | null;
    onPreempted?: (event: TurnPreemptionEvent) => void;
    now?: () => number;
  }) {}

  isPreemptableLane(laneClass: RuntimeLaneClass): boolean {
    return resolveRuntimeLaneBudgetProfile(laneClass).preemptable;
  }

  /** prompt() guard: the calling turn was preempted before it started its run. */
  isCurrentTurnPreempted(): boolean {
    const messageId = this.deps.currentTurnMessageId();
    return messageId !== null && (this.turns.get(messageId)?.preemptedBy ?? null) !== null;
  }

  /** Run a preemptable turn under tracking; a preempted turn fails with the typed contention. */
  async track<T>(
    input: { messageId: string; laneClass: RuntimeLaneClass },
    run: () => Promise<T>,
  ): Promise<T> {
    let settle!: () => void;
    const entry: TrackedTurn = {
      messageId: input.messageId,
      laneClass: input.laneClass,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      preemptedBy: null,
    };
    this.turns.set(input.messageId, entry);
    try {
      const result = await run();
      if (entry.preemptedBy !== null) throw new AgentRunPreemptedError();
      return result;
    } catch (error) {
      if (entry.preemptedBy !== null) throw new AgentRunPreemptedError();
      throw error;
    } finally {
      if (this.turns.get(input.messageId) === entry) this.turns.delete(input.messageId);
      settle();
    }
  }

  /**
   * Preempt every tracked turn of a lower-priority lane and resolve once each
   * has released the agent. Returns null (synchronously) when nothing is
   * tracked, so an uncontended turn keeps its exact dispatch ordering.
   */
  preemptFor(preemptor: { messageId: string; laneClass: RuntimeLaneClass }): Promise<TurnPreemptionEvent[]> | null {
    const victims = [...this.turns.values()].filter(turn => (
      turn.preemptedBy === null && compareRuntimeLanePriority(preemptor.laneClass, turn.laneClass) < 0
    ));
    if (victims.length === 0) return null;
    return this.preemptVictims(preemptor, victims);
  }

  private async preemptVictims(
    preemptor: { messageId: string; laneClass: RuntimeLaneClass },
    victims: TrackedTurn[],
  ): Promise<TurnPreemptionEvent[]> {
    const now = this.deps.now ?? Date.now;
    const startedAtMs = now();
    for (const victim of victims) victim.preemptedBy = preemptor.messageId;
    const activeRun = this.deps.preemptActiveRun(active => shouldPreemptAgentRun(active, preemptor.laneClass));
    await Promise.all([activeRun, ...victims.map(victim => victim.settled)]);
    const waitedMs = now() - startedAtMs;
    const events = victims.map(victim => ({
      preemptorMessageId: preemptor.messageId,
      preemptorLaneClass: preemptor.laneClass,
      preemptedMessageId: victim.messageId,
      preemptedLaneClass: victim.laneClass,
      abortedActiveRun: activeRun !== null,
      waitedMs,
    }));
    for (const event of events) this.deps.onPreempted?.(event);
    return events;
  }
}
