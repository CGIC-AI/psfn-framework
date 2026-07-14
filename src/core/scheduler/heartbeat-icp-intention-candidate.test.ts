import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  PostTurnActionHandler,
  PostTurnActionQueueStatus,
  PostTurnActionRuntime,
} from '../agent/post-turn-action-runtime.js';
import {
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
} from '../intention/appraisal.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../intention/pending-follow-up-store-port.js';
import { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import { ExternalCommunicationRateLimiter } from '../../system/capabilities/safeguards.js';
import type { HeartbeatAgent } from './heartbeat-runtime-contracts.js';
import { Scheduler } from './scheduler.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pendingFollowUp(): PendingFollowUp {
  return {
    id: 'follow-up-1',
    content: 'Check in with peer',
    priority: 'medium',
    timing: 'immediate',
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    channelId: 'discord:primary',
    channelType: 'discord',
    authorId: 'system:intention',
    authorName: 'Whisper',
    contactId: 'peer-contact',
  };
}

function emptyQueueStatus(): PostTurnActionQueueStatus {
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
    backPressure: { droppedCount: 0, recentDrops: [] },
    failures: { failedCount: 0, recentFailures: [] },
    terminal: { cancelledCount: 0, acknowledgedCount: 0, recentTerminals: [] },
    completions: { completedCount: 0, recentCompletions: [] },
    quarantine: { count: 0, persisted: true, entries: [] },
    persistence: {
      enabled: false,
      loadState: 'not_configured',
      loadedEntries: 0,
      quarantinedEntries: 0,
      quarantinePersisted: false,
    },
  };
}

function wire(kind: 'submitted' | 'blocked' | 'not_companion') {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-intention-'));
  TEMP_DIRS.push(dataDir);
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 });
  const handlers = new Map<string, PostTurnActionHandler>();
  const proactiveOutbound = new ProactiveOutboundDispatcher({
    sender: { send: vi.fn() },
    rateLimiter: new ExternalCommunicationRateLimiter(),
    isApprovedPrimaryChannel: () => true,
  });
  const dispatch = vi.spyOn(proactiveOutbound, 'dispatch');
  const submit = vi.fn().mockResolvedValue(
    kind === 'submitted'
      ? {
          kind: 'submitted',
          result: {
            outcome: 'sent',
            candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'consumed',
          },
        }
      : kind === 'blocked'
        ? { kind: 'blocked', reason: 'stale_provenance' }
        : { kind: 'not_companion' },
  );
  const pending = pendingFollowUp();
  const pendingFollowUpStore: PendingFollowUpStorePort = {
    enqueue: vi.fn(),
    peek: vi.fn(async () => pending),
    dequeue: vi.fn(),
    quarantine: vi.fn(),
    list: vi.fn(),
    listQuarantined: vi.fn(),
  };
  const postTurnActions: PostTurnActionRuntime = {
    registerHandler: vi.fn((actionKind: string, handler: PostTurnActionHandler) => {
      handlers.set(actionKind, handler);
      return () => undefined;
    }),
    listQueued: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
    acknowledge: vi.fn().mockReturnValue(false),
    getActionStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(emptyQueueStatus()),
  };
  const agentLoop: HeartbeatAgent = {
    handleMessage: vi.fn(),
    followUp: vi.fn(),
    registerPostTurnActionInferer: vi.fn(() => () => undefined),
  };
  const llmProvider: LLMProviderPort = {
    stream: vi.fn(),
    complete: vi.fn(),
  };
  void wireHeartbeatRuntime(
    { registerTool: vi.fn() },
    scheduler,
    agentLoop,
    { send: vi.fn() },
    dataDir,
    undefined,
    {
      eventBus,
      postTurnActions,
      llmProvider,
      pendingFollowUpStore,
      proactiveOutbound,
      icpIntentionCandidateAdapter: { submit },
    },
  );
  const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
  if (!handler) throw new Error('intention outbound handler was not registered');
  return { handler, submit, dispatch, handlers, agentLoop };
}

const ACTION = {
  id: 'action-1',
  kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  dedupeKey: 'intention.outbound_message:message-1:hash',
  channelId: 'discord:primary',
  sourceMessageId: 'message-1',
  inferredAt: Date.now(),
  payload: {
    channelId: 'discord:primary',
    channelType: 'discord',
    content: 'Peer-visible draft',
    pendingFollowUpId: 'follow-up-1',
  },
} satisfies InferredPostTurnAction;

describe('heartbeat ICP intention candidate integration', () => {
  it('carries a resurfaced ICP root onto the generated follow-up turn', async () => {
    const { handlers, agentLoop } = wire('submitted');
    const handler = handlers.get(INTENTION_FOLLOW_UP_ACTION_KIND);
    if (!handler) throw new Error('intention follow-up handler was not registered');

    await handler({
      ...ACTION,
      id: 'follow-up-action',
      kind: INTENTION_FOLLOW_UP_ACTION_KIND,
      payload: {
        channelId: 'discord:primary',
        channelType: 'discord',
        authorId: 'system:intention',
        authorName: 'Whisper',
        content: 'Reconsider peer outreach.',
        originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });

    expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
      routing: {
        originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }));
  });

  it('routes a live peer intention to the candidate broker and never dispatches draft text', async () => {
    const { handler, submit, dispatch } = wire('submitted');
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'icp_candidate:sent:consumed',
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails a stale companion provenance recheck closed without human-send fallback', async () => {
    const { handler, dispatch } = wire('blocked');
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'blocked:stale_provenance',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves the existing outbound path for a non-companion contact', async () => {
    const { handler, dispatch } = wire('not_companion');
    await expect(handler(ACTION)).resolves.toEqual({ detail: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
