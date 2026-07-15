import { describe, expect, it } from 'vitest';
import { TurnQueueIngressCoordinator } from './turn-queue-ingress.js';
import type { TurnRunOwnerAttribution } from './turn-run-reservation.js';
import type { Agent, AgentEvent, AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Minimal event-emitting Agent stand-in exercising the coordinator's queue seam. */
class FakeAgent {
  readonly followUpCalls: AgentMessage[] = [];
  private queued = false;
  private readonly subscribers: Array<(event: AgentEvent) => void> = [];

  followUp(message: AgentMessage): void {
    this.followUpCalls.push(message);
    this.queued = true;
  }

  hasQueuedMessages(): boolean {
    return this.queued;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.push(listener);
    return () => {};
  }

  emit(event: AgentEvent): void {
    for (const listener of this.subscribers) listener(event);
  }
}

function makeCoordinator(overrides?: {
  resolveOwner?: () => TurnRunOwnerAttribution | null;
  runFreshOrdinary?: (message: SubstrateMessage) => Promise<void>;
}): { coordinator: TurnQueueIngressCoordinator; agent: FakeAgent } {
  const agent = new FakeAgent();
  const coordinator = new TurnQueueIngressCoordinator({
    agent: agent as unknown as Agent,
    resolveOwner: overrides?.resolveOwner ?? (() => null),
    runFreshOrdinary: overrides?.runFreshOrdinary ?? (async () => {}),
  });
  // Mirror substrate-agent wiring: agent events drive the coordinator.
  agent.subscribe((event) => coordinator.observeAgentEvent(event));
  return { coordinator, agent };
}

function makeWhisper(content: string): AgentMessage {
  return {
    role: 'custom',
    type: 'internalWhisper',
    content,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function makeSubstrateMessage(id: string): SubstrateMessage {
  return {
    id,
    channelId: 'test-channel',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'TestUser',
    content: `content-${id}`,
    timestamp: new Date(),
  };
}

describe('TurnQueueIngressCoordinator pending-flush bookkeeping', () => {
  it('flushes a deferred whisper once and does not re-enqueue it on a later flush', () => {
    const { coordinator, agent } = makeCoordinator();
    const whisper = makeWhisper('breathe');
    coordinator.deferInternalFollowUp(whisper);

    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();

    expect(agent.followUpCalls).toEqual([whisper]);
  });

  it('splices a delivered whisper on the message_start carrying its exact reference', () => {
    const { coordinator, agent } = makeCoordinator();
    const whisper = makeWhisper('breathe');
    coordinator.deferInternalFollowUp(whisper);
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();

    // The by-reference message_start removes the delivered entry, so re-deferring
    // the same object produces a fresh entry that flushes again.
    coordinator.observeAgentEvent({ type: 'message_start', message: whisper });
    coordinator.deferInternalFollowUp(whisper);
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();

    expect(agent.followUpCalls).toEqual([whisper, whisper]);
  });

  it('never splices a whisper on a spread-cloned message_start', () => {
    const { coordinator, agent } = makeCoordinator();
    const whisper = makeWhisper('breathe');
    coordinator.deferInternalFollowUp(whisper);
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();

    // Assistant message_start events are spread-cloned upstream and must never
    // false-match a pending whisper.
    coordinator.observeAgentEvent({ type: 'message_start', message: { ...whisper } as AgentMessage });
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();

    expect(agent.followUpCalls).toEqual([whisper]);
  });
});

describe('TurnQueueIngressCoordinator active-run coalescing', () => {
  it('coalesces ingress into an active ordinary run only while agent events say it is owned', () => {
    let currentOwner: TurnRunOwnerAttribution | null = null;
    const { coordinator, agent } = makeCoordinator({ resolveOwner: () => currentOwner });

    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(false);

    // A real ordinary run starts and emits agent_start (the event the idle-FIFO
    // integration test never fired), so activePiQueueOwner is now set.
    currentOwner = { kind: 'ordinary-turn', sourceId: 'run-1' };
    agent.emit({ type: 'agent_start' });
    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(true);

    agent.emit({ type: 'agent_end', messages: [] });
    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(false);

    // A candidate-owned run must never accept coalesced ingress.
    currentOwner = { kind: 'candidate-turn', sourceId: 'cand-1' };
    agent.emit({ type: 'agent_start' });
    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(false);
    agent.emit({ type: 'agent_end', messages: [] });
  });

  it('lets a concurrent whisper coalesce into a fresh ordinary run once its agent_start fires', async () => {
    let currentOwner: TurnRunOwnerAttribution | null = null;
    const runGate = deferred();
    const { coordinator, agent } = makeCoordinator({
      resolveOwner: () => currentOwner,
      runFreshOrdinary: async () => {
        currentOwner = { kind: 'ordinary-turn', sourceId: 'fresh-run' };
        agent.emit({ type: 'agent_start' });
        await runGate.promise;
        agent.emit({ type: 'agent_end', messages: [] });
        currentOwner = null;
      },
    });

    const slot = coordinator.reserveFreshOrdinarySlot();
    const running = slot.run(makeSubstrateMessage('fresh-1'));
    await nextTick();

    // The run is active because agent_start fired, so a concurrent whisper
    // coalesces into it rather than starting yet another fresh turn.
    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(true);
    const whisper = makeWhisper('coalesce me');
    coordinator.deferInternalFollowUp(whisper);
    coordinator.enqueuePendingInternalFollowUpsForOrdinaryRun();
    expect(agent.followUpCalls).toEqual([whisper]);

    runGate.release();
    await running;
    expect(coordinator.canQueueIntoActiveOrdinaryRun()).toBe(false);
  });
});

describe('TurnQueueIngressCoordinator fresh-ordinary FIFO slots', () => {
  it('releases the FIFO slot when a run throws so the next slot still proceeds', async () => {
    const order: string[] = [];
    const { coordinator } = makeCoordinator({
      runFreshOrdinary: async (message) => {
        order.push(`run:${message.id}`);
        if (message.id === 'boom') {
          // Mirrors pi-agent-core's 'Agent is already processing' throw that can
          // surface between a fresh-ordinary prompt and its agent_start; the slot
          // finally must still fire so the chain self-heals (no lock leak).
          throw new Error('Agent is already processing');
        }
      },
    });

    const slotOne = coordinator.reserveFreshOrdinarySlot();
    const slotTwo = coordinator.reserveFreshOrdinarySlot();
    const runOne = slotOne.run(makeSubstrateMessage('boom'));
    const runTwo = slotTwo.run(makeSubstrateMessage('next'));

    await expect(runOne).rejects.toThrow('Agent is already processing');
    await runTwo;
    expect(order).toEqual(['run:boom', 'run:next']);
  });

  it('releases the FIFO slot on dispose so an abandoned position never blocks the next run', async () => {
    const order: string[] = [];
    const { coordinator } = makeCoordinator({
      runFreshOrdinary: async (message) => {
        order.push(`run:${message.id}`);
      },
    });

    const abandoned = coordinator.reserveFreshOrdinarySlot();
    const active = coordinator.reserveFreshOrdinarySlot();
    // The first position is abandoned because its input joined an active run.
    abandoned.dispose();
    await active.run(makeSubstrateMessage('after-abandon'));

    expect(order).toEqual(['run:after-abandon']);
  });

  it('preserves arrival order across concurrent slots claimed before their runs start', async () => {
    const order: string[] = [];
    const firstGate = deferred();
    const { coordinator } = makeCoordinator({
      runFreshOrdinary: async (message) => {
        order.push(`run:${message.id}`);
        if (message.id === 'first') await firstGate.promise;
      },
    });

    // Slots are claimed synchronously in arrival order, before any run awaits.
    const slotOne = coordinator.reserveFreshOrdinarySlot();
    const slotTwo = coordinator.reserveFreshOrdinarySlot();
    const slotThree = coordinator.reserveFreshOrdinarySlot();
    const runs = [
      slotOne.run(makeSubstrateMessage('first')),
      slotTwo.run(makeSubstrateMessage('second')),
      slotThree.run(makeSubstrateMessage('third')),
    ];

    await nextTick();
    // Only the head slot runs; successors block on their FIFO predecessor.
    expect(order).toEqual(['run:first']);

    firstGate.release();
    await Promise.all(runs);
    expect(order).toEqual(['run:first', 'run:second', 'run:third']);
  });
});
