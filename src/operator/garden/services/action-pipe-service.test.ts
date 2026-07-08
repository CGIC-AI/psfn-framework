import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionRuntime, PostTurnActionQueueStatus } from '../../../core/agent/post-turn-action-runtime.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import { AdminActionPipeDataService } from './action-pipe-service.js';

function makeStatus(): PostTurnActionQueueStatus {
  return {
    timestamp: 1,
    processing: false,
    queueDepth: 0,
    maxQueueDepth: 4,
    availableSlots: 4,
    saturated: false,
    readyCount: 0,
    scheduledCount: 0,
    retryScheduledCount: 0,
    runningCount: 0,
    lanes: [],
    queued: [],
    backPressure: {
      droppedCount: 0,
      recentDrops: [],
    },
    failures: {
      failedCount: 0,
      recentFailures: [],
    },
    terminal: {
      cancelledCount: 0,
      acknowledgedCount: 0,
      recentTerminals: [],
    },
    completions: {
      completedCount: 0,
      recentCompletions: [],
    },
    quarantine: {
      count: 0,
      persisted: true,
      entries: [],
    },
    persistence: {
      enabled: true,
      loadState: 'loaded',
      loadedEntries: 0,
      quarantinedEntries: 0,
      quarantinePersisted: true,
    },
  };
}

describe('AdminActionPipeDataService', () => {
  it('includes recent outreach outbox records in action-pipe status', async () => {
    const runtime = {
      getStatus: vi.fn(() => makeStatus()),
      getActionStatus: vi.fn(),
      cancel: vi.fn(),
      acknowledge: vi.fn(),
    } as unknown as PostTurnActionRuntime;
    const outbox = {
      listRecent: vi.fn(() => [{
        version: 1,
        phase: 'sent',
        actionId: 'outbound-action-1',
        dedupeKey: 'outbound-dedupe-1',
        channelId: 'discord:primary',
        channelType: 'discord',
        sourceMessageId: 'source-message-1',
        recordedAt: 1_700_000_000_000,
        contentHash: 'abc123',
        contentLength: 42,
      }]),
    } as unknown as OutreachOutboxStore;

    const service = new AdminActionPipeDataService(runtime, outbox);
    const status = await service.getActionPipeStatus();

    expect(outbox.listRecent).toHaveBeenCalledWith(25);
    expect(status.outreachOutbox?.recentRecords).toEqual([
      expect.objectContaining({
        phase: 'sent',
        actionId: 'outbound-action-1',
        channelId: 'discord:primary',
      }),
    ]);
  });
});
