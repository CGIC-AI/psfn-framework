import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ObservedGroupMemoryScheduleDecision } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { ObservedGroupMemoryLane } from './observed-group-memory-lane.js';

function message(channelId: string, id: string): SubstrateMessage {
  return {
    id,
    channelId,
    channelType: 'external',
    authorId: 'author',
    authorName: 'Author',
    content: 'line',
    timestamp: new Date(0),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const skipped = (channelId: string): ObservedGroupMemoryScheduleDecision => ({
  status: 'skipped',
  channelId,
  reason: 'threshold_not_met',
});

function lane(observe: (message: SubstrateMessage) => Promise<ObservedGroupMemoryScheduleDecision>) {
  const audit = { append: vi.fn() };
  const log = { warn: vi.fn() };
  const scheduler = { observeMessage: vi.fn(observe) };
  return { lane: new ObservedGroupMemoryLane({ scheduler, audit, log }), scheduler, audit, log };
}

describe('ObservedGroupMemoryLane (psfn-framework-qvwem)', () => {
  it('schedules one channel strictly in order while other channels proceed', async () => {
    const first = deferred<ObservedGroupMemoryScheduleDecision>();
    const rig = lane(async (m) => (m.id === 'a-1' ? await first.promise : skipped(m.channelId)));
    const a1 = rig.lane.enqueue(message('room-a', 'a-1'));
    const a2 = rig.lane.enqueue(message('room-a', 'a-2'));
    const b1 = rig.lane.enqueue(message('room-b', 'b-1'));
    await b1;
    // room-b is not blocked by room-a's slow extraction...
    expect(rig.scheduler.observeMessage.mock.calls.map(([m]) => m.id)).toEqual(['a-1', 'b-1']);
    expect(rig.lane.pendingCount).toBe(2);
    // ...and room-a's second line waits for its first.
    first.resolve(skipped('room-a'));
    await Promise.all([a1, a2]);
    expect(rig.scheduler.observeMessage.mock.calls.map(([m]) => m.id)).toEqual(['a-1', 'b-1', 'a-2']);
    expect(rig.lane.pendingCount).toBe(0);
  });

  it('audits scheduled spans and failures instead of swallowing them, and keeps the channel moving', async () => {
    const rig = lane(async (m) => {
      if (m.id === 'boom') throw new Error('classifier unavailable');
      if (m.id === 'failed') {
        return { status: 'skipped', channelId: m.channelId, reason: 'extraction_failed', error: 'model timeout' };
      }
      return {
        status: 'scheduled',
        channelId: m.channelId,
        triggerReason: 'direct_mention',
        spanStartMessageId: 1,
        spanEndMessageId: 4,
        newEntryCount: 4,
        watermarkLagMessageIds: 4,
        hasDeferredBacklog: false,
      };
    });
    await rig.lane.enqueue(message('room', 'boom'));
    await rig.lane.enqueue(message('room', 'failed'));
    await rig.lane.enqueue(message('room', 'ok'));
    expect(rig.audit.append).toHaveBeenCalledWith('memory.group_observed.error', expect.objectContaining({
      messageId: 'boom',
      error: 'classifier unavailable',
    }));
    expect(rig.audit.append).toHaveBeenCalledWith('memory.group_observed.error', expect.objectContaining({
      messageId: 'failed',
      reason: 'extraction_failed',
      error: 'model timeout',
    }));
    expect(rig.audit.append).toHaveBeenCalledWith('memory.group_observed.scheduled', expect.objectContaining({
      messageId: 'ok',
      triggerReason: 'direct_mention',
    }));
    expect(rig.log.warn).toHaveBeenCalledTimes(2);
  });

  it('drains on stop, reports a bounded drain, and refuses new work with an audited deferral', async () => {
    const slow = deferred<ObservedGroupMemoryScheduleDecision>();
    const rig = lane(async () => await slow.promise);
    void rig.lane.enqueue(message('room', 'slow'));
    expect(await rig.lane.stop({ timeoutMs: 5 })).toBe(false);
    await rig.lane.enqueue(message('room', 'late'));
    expect(rig.scheduler.observeMessage).toHaveBeenCalledTimes(1);
    expect(rig.audit.append).toHaveBeenCalledWith('memory.group_observed.deferred', {
      channelId: 'room',
      messageId: 'late',
      reason: 'lane_stopped',
    });
    slow.resolve(skipped('room'));
    expect(await rig.lane.stop({ timeoutMs: 1_000 })).toBe(true);
  });
});
