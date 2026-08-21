import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type {
  ScheduledPromptRecord,
  ScheduledPromptStorePort,
} from '../scheduler/scheduled-prompt-store-port.js';
import { createLongHorizonFollowUpRouter } from './long-horizon-follow-up.js';

function makeInput() {
  return {
    content: 'Revisit the long-range commitment.',
    reason: 'The near-term attention queue is not a calendar.',
    dueAt: '2026-09-19T12:00:00.000Z',
    channelId: 'api:test',
    channelType: 'api' as const,
    authorId: 'system:intention' as const,
    authorName: 'Whisper' as const,
    contactId: 'contact-a',
    sourceMessageId: 'msg-long-horizon',
    contextSummary: 'Long-range commitment context.',
  };
}

function makeHarness(existing?: ScheduledPromptRecord) {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 10,
    heartbeatIntervalMs: 1_000,
  });
  let record = existing;
  const create = vi.fn(async (input): Promise<ScheduledPromptRecord> => {
    if (record) throw new Error('duplicate key value violates unique constraint');
    record = {
      ...input,
      createdAt: input.createdAt ?? '2026-08-20T12:00:00.000Z',
      status: 'pending',
    };
    return record;
  });
  const store: ScheduledPromptStorePort = {
    create,
    getById: vi.fn(async id => record?.id === id ? record : null),
    listPending: vi.fn(async () => record ? [record] : []),
    markCompleted: vi.fn(async () => null),
  };
  const router = createLongHorizonFollowUpRouter({
    store,
    scheduler,
    agentLoop: {
      handleMessage: vi.fn(async () => ({ content: 'done' })),
    },
    sender: { send: vi.fn(async () => undefined) },
    now: () => Date.parse('2026-08-20T12:00:00.000Z'),
  });
  return { router, scheduler, store, create, get record() { return record; } };
}

describe('long-horizon intention routing', () => {
  it('persists and registers a scheduled prompt instead of a pending follow-up', async () => {
    const harness = makeHarness();
    const id = await harness.router(makeInput());

    expect(harness.record).toMatchObject({
      id,
      source: 'intention_appraisal',
      prompt: 'Revisit the long-range commitment.',
      runAt: '2026-09-19T12:00:00.000Z',
      channelId: 'api:test',
      authorId: 'system:intention',
      status: 'pending',
    });
    expect(harness.scheduler.getTask(id)).toMatchObject({
      id,
      type: 'one-shot',
      runAt: Date.parse('2026-09-19T12:00:00.000Z'),
    });
  });

  it('replays the exact durable schedule idempotently', async () => {
    const harness = makeHarness();
    const first = await harness.router(makeInput());
    const second = await harness.router(makeInput());

    expect(second).toBe(first);
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.scheduler.getTask(first)).toBeDefined();
  });

  it('rejects a conflicting durable row instead of treating it as the same commitment', async () => {
    const initial = makeHarness();
    const id = await initial.router(makeInput());
    const conflicting: ScheduledPromptRecord = {
      ...initial.record!,
      id,
      prompt: 'Different work.',
    };
    const replay = makeHarness(conflicting);

    await expect(replay.router(makeInput())).rejects.toThrow('conflicts with the durable scheduled prompt');
  });
});
