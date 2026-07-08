import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import { EventBus } from '../../shared/event-bus.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import { INTENTION_FOLLOW_UP_ACTION_KIND } from '../intention/appraisal.js';
import { Scheduler } from './scheduler.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ActionHandler = (action: {
  id: string;
  dedupeKey: string;
  channelId: string;
  sourceMessageId: string;
  payload: Record<string, unknown>;
}) => Promise<unknown> | unknown;

function makePendingFollowUp(input: {
  id: string;
  content?: string;
  dueAt: string;
  channelId?: string;
}): PendingFollowUp {
  return {
    id: input.id,
    content: input.content ?? `Follow-up ${input.id}`,
    priority: 'medium',
    timing: 'scheduled',
    createdAt: '2026-03-25T11:00:00.000Z',
    channelId: input.channelId ?? 'discord:primary',
    channelType: 'discord',
    authorId: 'system:intention',
    authorName: 'Whisper',
    dueAt: input.dueAt,
    contactId: 'contact-a',
  };
}

function makeAction(id: string, pendingFollowUpId: string) {
  return {
    id,
    dedupeKey: `intention.follow_up:pending:${pendingFollowUpId}`,
    channelId: 'discord:primary',
    sourceMessageId: `msg-${id}`,
    payload: {
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      content: `Follow-up ${pendingFollowUpId}`,
      pendingFollowUpId,
    },
  };
}

function wire(pendingFollowUps: readonly PendingFollowUp[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-follow-up-gate-'));
  TEMP_DIRS.push(tempDir);
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
  const handlers = new Map<string, ActionHandler>();
  const followUp = vi.fn();
  const onIntentionFollowUpActivated = vi.fn(async () => undefined);
  const pendingById = new Map(pendingFollowUps.map(followUpRecord => [followUpRecord.id, followUpRecord]));
  const pendingFollowUpStore = {
    enqueue: vi.fn(),
    peek: vi.fn(async (id: string) => pendingById.get(id) ?? null),
    dequeue: vi.fn(),
    quarantine: vi.fn(),
    list: vi.fn(),
    listQuarantined: vi.fn(),
  };
  const postTurnActions = {
    registerHandler: vi.fn((kind: string, handler: ActionHandler) => {
      handlers.set(kind, handler);
      return () => {};
    }),
    listQueued: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  };

  wireHeartbeatRuntime(
    { registerTool: vi.fn() },
    scheduler,
    {
      handleMessage: vi.fn(),
      followUp,
      waitForIdle: vi.fn(),
      registerPostTurnActionInferer: vi.fn(() => () => {}),
    } as any,
    { send: vi.fn() },
    tempDir,
    undefined,
    {
      eventBus,
      postTurnActions: postTurnActions as any,
      llmProvider: { stream: vi.fn(), complete: vi.fn() } as any,
      sessionManager: {
        resolveSessionChannelId: (channelId: string) => channelId,
        getRecentMessages: vi.fn().mockReturnValue([]),
      } as any,
      pendingFollowUpStore: pendingFollowUpStore as any,
      onIntentionFollowUpActivated,
    },
  );

  const handler = handlers.get(INTENTION_FOLLOW_UP_ACTION_KIND);
  if (!handler) {
    throw new Error('intention follow-up handler was not registered');
  }
  return {
    handler,
    followUp,
    onIntentionFollowUpActivated,
  };
}

describe('heartbeat intention follow-up activation gating', () => {
  it('does not activate a pending follow-up before dueAt or a wake condition is due', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const harness = wire([
        makePendingFollowUp({
          id: 'pending-future',
          dueAt: '2023-11-14T22:14:20.000Z',
        }),
      ]);

      await harness.handler(makeAction('action-future', 'pending-future'));

      expect(harness.onIntentionFollowUpActivated).not.toHaveBeenCalled();
      expect(harness.followUp).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('enforces one activation per channel budget window', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const harness = wire([
        makePendingFollowUp({
          id: 'pending-due-1',
          dueAt: '2023-11-14T22:12:00.000Z',
        }),
        makePendingFollowUp({
          id: 'pending-due-2',
          dueAt: '2023-11-14T22:12:00.000Z',
        }),
      ]);

      await harness.handler(makeAction('action-due-1', 'pending-due-1'));
      await harness.handler(makeAction('action-due-2', 'pending-due-2'));

      expect(harness.onIntentionFollowUpActivated).toHaveBeenCalledTimes(1);
      expect(harness.onIntentionFollowUpActivated).toHaveBeenCalledWith({
        pendingFollowUpId: 'pending-due-1',
        activationReason: 'post_turn_action',
      });
      expect(harness.followUp).toHaveBeenCalledTimes(1);
      expect(harness.followUp).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Follow-up pending-due-1',
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });
});
