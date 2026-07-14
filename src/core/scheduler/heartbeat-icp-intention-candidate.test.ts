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
import { createFileOutreachOutboxStore } from '../intention/outreach-outbox.js';
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

function wire(
  kind: 'submitted' | 'suppressed' | 'deferred' | 'declined' | 'blocked' | 'not_companion',
  options: { activation?: 'success' | 'fail_once' | 'false' | 'missing' } = {},
) {
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
    kind === 'submitted' || kind === 'suppressed'
      ? {
          kind: 'submitted',
          result: {
            outcome: kind === 'submitted' ? 'sent' : 'suppressed',
            candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'consumed',
            pendingFollowUpId: 'follow-up-1',
            deliveryDisposition: kind === 'submitted' ? 'delivered' : 'suppressed',
          },
        }
      : kind === 'deferred'
        ? {
            kind: 'submitted',
            result: {
              outcome: 'deferred',
              candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              status: 'deferred',
            },
          }
        : kind === 'declined'
          ? {
              kind: 'submitted',
              result: {
                outcome: 'declined',
                candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                status: 'declined',
                pendingFollowUpId: 'follow-up-1',
              },
            }
      : kind === 'blocked'
        ? { kind: 'blocked', reason: 'stale_provenance' }
        : { kind: 'not_companion' },
  );
  const pending = pendingFollowUp();
  let storedPending: PendingFollowUp | null = pending;
  const pendingFollowUpStore: PendingFollowUpStorePort = {
    enqueue: vi.fn(),
    peek: vi.fn(async () => storedPending),
    dequeue: vi.fn(async (_id, options) => {
      if (!storedPending || storedPending.activatedAt) return null;
      storedPending = {
        ...storedPending,
        activatedAt: new Date().toISOString(),
        ...(options?.activationReason ? { activationReason: options.activationReason } : {}),
      };
      return storedPending;
    }),
    dampen: vi.fn(async (_id, options) => {
      if (!storedPending || storedPending.activatedAt || storedPending.dampenedAt) return null;
      storedPending = {
        ...storedPending,
        dampenedAt: new Date().toISOString(),
        dampeningReason: options.dampeningReason,
      };
      return storedPending;
    }),
    quarantine: vi.fn(),
    list: vi.fn(),
    listQuarantined: vi.fn(),
  };
  let activationAttempts = 0;
  const onIntentionFollowUpActivated = vi.fn(async ({
    pendingFollowUpId,
    activationReason,
  }: {
    pendingFollowUpId: string;
    activationReason?: string;
  }) => {
    activationAttempts += 1;
    if (options.activation === 'fail_once' && activationAttempts === 1) {
      throw new Error('injected activation persistence failure');
    }
    if (options.activation === 'false') return false;
    return (
      await pendingFollowUpStore.dequeue(pendingFollowUpId, {
      ...(activationReason ? { activationReason } : {}),
    })
    ) !== null;
  });
  const outreachOutbox = createFileOutreachOutboxStore(join(dataDir, 'outreach-outbox.jsonl'));
  const onIntentionFollowUpDampened = vi.fn(async ({
    pendingFollowUpId,
    dampeningReason,
  }: {
    pendingFollowUpId: string;
    dampeningReason: string;
  }) => (
    await pendingFollowUpStore.dampen?.(pendingFollowUpId, { dampeningReason })
  ) != null);
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
      ...(options.activation === 'missing' ? {} : { onIntentionFollowUpActivated }),
      onIntentionFollowUpDampened,
      proactiveOutbound,
      outreachOutbox,
      icpIntentionCandidateAdapter: { submit },
    },
  );
  const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
  if (!handler) throw new Error('intention outbound handler was not registered');
  return {
    handler,
    submit,
    dispatch,
    handlers,
    agentLoop,
    pendingFollowUpStore,
    onIntentionFollowUpActivated,
    onIntentionFollowUpDampened,
    outreachOutbox,
  };
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

  it('consumes a sent ICP pending source and blocks a repeated candidate pipeline', async () => {
    const {
      handler,
      submit,
      dispatch,
      pendingFollowUpStore,
      onIntentionFollowUpActivated,
    } = wire('submitted');
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'icp_candidate:sent:consumed',
    });
    expect(onIntentionFollowUpActivated).toHaveBeenCalledWith({
      pendingFollowUpId: 'follow-up-1',
      activationReason: 'icp_candidate_sent',
    });
    await expect(pendingFollowUpStore.peek('follow-up-1')).resolves.toMatchObject({
      activatedAt: expect.any(String),
      activationReason: 'icp_candidate_sent',
    });
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'icp_candidate:delivery_reconciled',
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails closed before candidate submission when linked-source activation is unavailable', async () => {
    const { handler, submit } = wire('submitted', { activation: 'missing' });
    await expect(handler(ACTION)).rejects.toThrow('activation callback');
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps a false activation result retryable without repeating the candidate pipeline', async () => {
    const { handler, submit, pendingFollowUpStore } = wire('submitted', { activation: 'false' });
    await expect(handler(ACTION)).rejects.toThrow('remained live');
    await expect(handler({
      ...ACTION,
      id: 'action-2',
      dedupeKey: 'intention.outbound_message:message-2:other-hash',
    })).rejects.toThrow('remained live');
    expect(submit).toHaveBeenCalledOnce();
    await expect(pendingFollowUpStore.peek('follow-up-1')).resolves.not.toHaveProperty('activatedAt');
  });

  it('reconciles a delivered candidate after activation failure under a new action identity', async () => {
    const {
      handler,
      submit,
      pendingFollowUpStore,
      onIntentionFollowUpActivated,
    } = wire('submitted', { activation: 'fail_once' });
    await expect(handler(ACTION)).rejects.toThrow('injected activation persistence failure');
    await expect(handler({
      ...ACTION,
      id: 'action-after-restart',
      dedupeKey: 'intention.outbound_message:restart:new-hash',
    })).resolves.toEqual({ detail: 'icp_candidate:delivery_reconciled' });
    expect(submit).toHaveBeenCalledOnce();
    expect(onIntentionFollowUpActivated).toHaveBeenCalledTimes(2);
    await expect(pendingFollowUpStore.peek('follow-up-1')).resolves.toMatchObject({
      activatedAt: expect.any(String),
      activationReason: 'icp_candidate_sent',
    });
  });

  it('fails a stale companion provenance recheck closed without human-send fallback', async () => {
    const { handler, dispatch } = wire('blocked');
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'blocked:stale_provenance',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a pending source live while ICP is deferred', async () => {
    const {
      handler,
      submit,
      pendingFollowUpStore,
      onIntentionFollowUpActivated,
    } = wire('deferred');
    await expect(handler(ACTION)).resolves.toEqual({
      detail: 'icp_candidate:deferred:deferred',
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(onIntentionFollowUpActivated).not.toHaveBeenCalled();
    await expect(pendingFollowUpStore.peek('follow-up-1')).resolves.not.toHaveProperty('activatedAt');
  });

  it.each([
    ['declined', 'declined', 'icp_candidate_declined'],
    ['suppressed', 'consumed', 'icp_candidate_suppressed'],
  ] as const)('dampens a pending source when ICP is %s', async (kind, status, dampeningReason) => {
    const {
      handler,
      submit,
      pendingFollowUpStore,
      onIntentionFollowUpActivated,
      onIntentionFollowUpDampened,
    } = wire(kind);
    await expect(handler(ACTION)).resolves.toEqual({
      detail: `icp_candidate:${kind}:${status}`,
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(onIntentionFollowUpActivated).not.toHaveBeenCalled();
    expect(onIntentionFollowUpDampened).toHaveBeenCalledWith({
      pendingFollowUpId: 'follow-up-1',
      dampeningReason,
    });
    await expect(pendingFollowUpStore.peek('follow-up-1')).resolves.toMatchObject({
      dampenedAt: expect.any(String),
      dampeningReason,
    });
  });

  it('preserves the existing outbound path for a non-companion contact', async () => {
    const { handler, dispatch } = wire('not_companion');
    await expect(handler(ACTION)).resolves.toEqual({ detail: 'sent' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
