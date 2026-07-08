import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from './scheduler.js';
import {
  rehydrateScheduledPromptTasks,
} from './scheduled-prompts.js';
import type {
  ScheduledPromptRecord,
  ScheduledPromptStorePort,
} from './scheduled-prompt-store-port.js';

function createRecord(overrides: Partial<ScheduledPromptRecord> = {}): ScheduledPromptRecord {
  return {
    id: 'planned:stored-1',
    name: 'Stored Prompt',
    prompt: 'Please remember to review the durable scheduled prompt.',
    runAt: '2099-03-08T07:00:00.000Z',
    createdAt: '2099-03-07T12:00:00.000Z',
    source: 'schedule_tool',
    channelId: 'internal:planned:stored-1',
    channelType: 'terminal',
    authorId: 'scheduler',
    authorName: 'Stored Prompt',
    status: 'pending',
    deliveryChannelId: 'discord:heartbeat',
    ...overrides,
  };
}

function createStore(records: ScheduledPromptRecord[]): ScheduledPromptStorePort {
  return {
    create: vi.fn(),
    listPending: vi.fn(async () => records.filter(record => record.status === 'pending')),
    markCompleted: vi.fn(async (id: string, options = {}) => {
      const record = records.find(candidate => candidate.id === id && candidate.status === 'pending');
      if (!record) return null;
      record.status = 'completed';
      record.completedAt = options.completedAt ?? new Date().toISOString();
      return record;
    }),
  };
}

function createRuntime(records: ScheduledPromptRecord[]) {
  const scheduler = new Scheduler(new EventBus(), {
    tickIntervalMs: 100,
    heartbeatIntervalMs: 500,
  });
  const store = createStore(records);
  const agentLoop = {
    handleMessage: vi.fn(async () => ({ content: 'scheduled response' })),
  };
  const sender = {
    send: vi.fn(async () => undefined),
  };
  return { scheduler, store, agentLoop, sender };
}

describe('scheduled prompt rehydration', () => {
  it('rehydrates pending prompt records into one-shot scheduler tasks', async () => {
    const record = createRecord();
    const { scheduler, store, agentLoop, sender } = createRuntime([record]);

    const count = await rehydrateScheduledPromptTasks({
      scheduler,
      agentLoop,
      sender,
      scheduledPromptStore: store,
      heartbeatChannelId: 'discord:heartbeat',
    });

    expect(count).toBe(1);
    expect(store.listPending).toHaveBeenCalledWith({ limit: 500 });
    expect(scheduler.getTask(record.id)).toMatchObject({
      id: record.id,
      name: record.name,
      type: 'one-shot',
      runAt: Date.parse(record.runAt),
      state: 'idle',
    });
  });

  it('fires past-due records on the first tick with a restart staleness note', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(Date.parse('2026-03-09T12:00:00.000Z'));
      const record = createRecord({
        id: 'planned:past-due',
        runAt: '2026-03-08T07:00:00.000Z',
      });
      const { scheduler, store, agentLoop, sender } = createRuntime([record]);

      await rehydrateScheduledPromptTasks({
        scheduler,
        agentLoop,
        sender,
        scheduledPromptStore: store,
        heartbeatChannelId: 'discord:heartbeat',
      });
      await scheduler.tick();

      expect(agentLoop.handleMessage).toHaveBeenCalledOnce();
      expect(agentLoop.handleMessage.mock.calls[0]?.[0].content).toContain(
        'scheduled for 2026-03-08T07:00:00.000Z and delivered late after a restart',
      );
      expect(sender.send).toHaveBeenCalledWith('discord:heartbeat', 'scheduled response');
      expect(store.markCompleted).toHaveBeenCalledWith('planned:past-due', {
        completedAt: '2026-03-09T12:00:00.000Z',
      });
      expect(record.status).toBe('completed');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not double-fire completed prompt records after restart', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(Date.parse('2026-03-09T12:00:00.000Z'));
      const record = createRecord({
        id: 'planned:single-fire',
        runAt: '2026-03-08T07:00:00.000Z',
      });
      const firstRuntime = createRuntime([record]);
      await rehydrateScheduledPromptTasks({
        scheduler: firstRuntime.scheduler,
        agentLoop: firstRuntime.agentLoop,
        sender: firstRuntime.sender,
        scheduledPromptStore: firstRuntime.store,
        heartbeatChannelId: 'discord:heartbeat',
      });
      await firstRuntime.scheduler.tick();
      expect(firstRuntime.agentLoop.handleMessage).toHaveBeenCalledOnce();

      const restarted = createRuntime([record]);
      await rehydrateScheduledPromptTasks({
        scheduler: restarted.scheduler,
        agentLoop: restarted.agentLoop,
        sender: restarted.sender,
        scheduledPromptStore: restarted.store,
        heartbeatChannelId: 'discord:heartbeat',
      });
      await restarted.scheduler.tick();

      expect(restarted.agentLoop.handleMessage).not.toHaveBeenCalled();
      expect(restarted.scheduler.getTask(record.id)).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
