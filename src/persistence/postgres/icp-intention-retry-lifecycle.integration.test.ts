import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type {
  PostTurnActionHandler,
  PostTurnActionQueueStatus,
  PostTurnActionRuntime,
} from '../../core/agent/post-turn-action-runtime.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../../core/intention/appraisal.js';
import { createFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { createPostgresIntentionPortsFromPool } from '../../core/intention/postgres-adapters.js';
import type {
  HeartbeatAgent,
  HeartbeatRuntimeOptions,
} from '../../core/scheduler/heartbeat-runtime-contracts.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  createPostgresPool,
  runPostgresMigrations,
} from '../postgres.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;
const RETRY_COOLDOWN_MS = 5 * 60_000;
const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: PostgresTestHarness | null = null;
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

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

async function wireOutboundHandler(options: {
  dataDir: string;
  adapter: ReturnType<typeof createIcpIntentionCandidateAdapter>;
  pendingFollowUpStore: ReturnType<typeof createPostgresIntentionPortsFromPool>['pendingFollowUpStore'];
  onIntentionFollowUpActivated: NonNullable<
    HeartbeatRuntimeOptions['onIntentionFollowUpActivated']
  >;
  onIntentionFollowUpDampened: NonNullable<
    HeartbeatRuntimeOptions['onIntentionFollowUpDampened']
  >;
}): Promise<PostTurnActionHandler> {
  const handlers = new Map<string, PostTurnActionHandler>();
  const postTurnActions: PostTurnActionRuntime = {
    registerHandler(kind, handler) {
      handlers.set(kind, handler);
      return () => undefined;
    },
    listQueued: () => [],
    cancel: () => false,
    acknowledge: () => false,
    getActionStatus: () => undefined,
    getStatus: emptyQueueStatus,
  };
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 50,
    heartbeatIntervalMs: 1_000,
  });
  const agentLoop: HeartbeatAgent = {
    handleMessage: vi.fn(async () => ({ content: '' })),
    followUp: vi.fn(),
    registerPostTurnActionInferer: vi.fn(() => () => undefined),
  };
  const llmProvider: LLMProviderPort = {
    stream: vi.fn(),
    complete: vi.fn(),
  };
  await wireHeartbeatRuntime(
    { registerTool: vi.fn() },
    scheduler,
    agentLoop,
    { send: vi.fn() },
    options.dataDir,
    undefined,
    {
      eventBus,
      postTurnActions,
      llmProvider,
      pendingFollowUpStore: options.pendingFollowUpStore,
      onIntentionFollowUpActivated: options.onIntentionFollowUpActivated,
      onIntentionFollowUpDampened: options.onIntentionFollowUpDampened,
      outreachOutbox: createFileOutreachOutboxStore(
        join(options.dataDir, 'outreach-outbox.jsonl'),
      ),
      icpIntentionCandidateAdapter: options.adapter,
    },
  );
  const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
  if (!handler) throw new Error('intention outbound handler was not registered');
  return handler;
}

function makeAction(pendingFollowUpId: string, suffix: string, inferredAt: number) {
  return {
    id: `retry-lifecycle-${suffix}`,
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    dedupeKey: `intention.outbound_message:retry-lifecycle-${suffix}`,
    channelId: 'api:test',
    sourceMessageId: 'retry-lifecycle-source',
    inferredAt,
    payload: {
      channelId: 'api:test',
      channelType: 'api',
      content: 'One durable peer outreach candidate.',
      pendingFollowUpId,
    },
  } satisfies InferredPostTurnAction;
}

describe('Postgres ICP intention retry and dampening lifecycle', () => {
  it(
    'expires a deferred candidate across restart before terminal dedupe',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_deferred_expiry';
      let nowMs = Date.parse('2026-07-14T02:00:00.000Z');
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      const preflight = vi.fn().mockResolvedValue({
        eligible: false as const,
        reasonCode: 'peer_busy' as const,
        reasonClass: 'deferrable' as const,
      });
      const consent = vi.fn();
      const issuePermit = vi.fn();
      const delivery = vi.fn();
      const peers = {
        resolveKnownPeer: vi.fn().mockResolvedValue({
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: PEER_COMPANION_ID,
        }),
        executeCompanionOutreach: delivery,
      };
      const request = {
        source: 'free_time' as const,
        peerContactId: 'peer-contact',
        preferredChannel: 'dm' as const,
        sourceRecordId: 'deferred-expiry-source',
        reasonSummary: 'Expire this deferred source before its retry cooldown.',
        cause: { kind: 'independent' as const },
        ttlMs: 1_000,
      };
      const createRuntime = (store: PostgresIcpInitiationCandidateStore) => (
        createIcpInitiationSourceRuntime({
          localCompanionId: LOCAL_COMPANION_ID,
          store,
          peers,
          gateway: {
            companionInitiationPreflight: preflight,
            companionIssueInitiationPermit: issuePermit,
          },
          consent: { evaluate: consent },
          isExternalCompanionAuthorized: () => true,
          now: () => nowMs,
        })
      );
      try {
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const first = await createRuntime(candidateStore).submit(request);
        expect(first).toMatchObject({ outcome: 'deferred', status: 'deferred' });

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        nowMs += 1_001;
        const expired = await createRuntime(candidateStore).submit(request);
        expect(expired).toMatchObject({
          candidateId: first.candidateId,
          outcome: 'deduped',
          status: 'expired',
          reasonCode: 'candidate_expired',
        });
        await expect(candidateStore.getCandidate(first.candidateId)).resolves.not.toHaveProperty(
          'retryEligibleAtMs',
        );
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();
      } finally {
        if (candidateStore) await candidateStore.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'retries peer_busy only after its durable cooldown on the same candidate',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_deferred_retry';
      let nowMs = Date.parse('2026-07-14T03:00:00.000Z');
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-deferred-retry',
        allowExitOnIdle: true,
        max: 4,
        schema,
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-deferred-retry-'));
      tempDirs.push(dataDir);
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, { schema });
        const ports = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date(nowMs),
          idFactory: () => 'pending-follow-up-deferred-retry',
        });
        const pending = await ports.pendingFollowUpStore.enqueue({
          content: 'Retry this peer outreach after the durable cooldown.',
          priority: 'medium',
          timing: 'immediate',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'retry-lifecycle-source',
        });
        if (!pending) throw new Error('pending follow-up was not created');

        const preflight = vi.fn()
          .mockResolvedValueOnce({
            eligible: false as const,
            reasonCode: 'peer_busy' as const,
            reasonClass: 'deferrable' as const,
          })
          .mockResolvedValue({ eligible: true as const });
        const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
        const issuePermit = vi.fn().mockImplementation(async ({ candidate }) => ({
          decision: { eligible: true as const },
          permit: {
            permitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            candidateId: candidate.candidateId,
            conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            senderCompanionId: LOCAL_COMPANION_ID,
            recipientCompanionId: PEER_COMPANION_ID,
            channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 60_000,
            status: 'issued' as const,
            revision: 1,
          },
        }));
        const delivery = vi.fn().mockResolvedValue({ disposition: 'delivered' as const });
        const peers = {
          resolveKnownPeer: vi.fn().mockResolvedValue({
            contactId: 'peer-contact',
            displayName: 'Peer',
            peerCompanionId: PEER_COMPANION_ID,
          }),
          executeCompanionOutreach: delivery,
        };
        const createHandler = async (store: PostgresIcpInitiationCandidateStore) => {
          const sourceRuntime = createIcpInitiationSourceRuntime({
            localCompanionId: LOCAL_COMPANION_ID,
            store,
            peers,
            gateway: {
              companionInitiationPreflight: preflight,
              companionIssueInitiationPermit: issuePermit,
            },
            consent: { evaluate: consent },
            isExternalCompanionAuthorized: () => true,
            now: () => nowMs,
          });
          return await wireOutboundHandler({
            dataDir,
            adapter: createIcpIntentionCandidateAdapter({
              sourceRuntime,
              peers,
              pendingFollowUpStore: ports.pendingFollowUpStore,
              concernStore: ports.concernStore,
              now: () => nowMs,
            }),
            pendingFollowUpStore: ports.pendingFollowUpStore,
            onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => (
              await ports.pendingFollowUpStore.dequeue(pendingFollowUpId, {
                ...(activationReason ? { activationReason } : {}),
              })
            ) !== null,
            onIntentionFollowUpDampened: async ({ pendingFollowUpId, dampeningReason }) => {
              const dampened = await ports.pendingFollowUpStore.dampen?.(
                pendingFollowUpId,
                { dampeningReason },
              );
              return dampened != null;
            },
          });
        };

        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const firstHandler = await createHandler(candidateStore);
        await expect(firstHandler(makeAction(pending.id, 'first', nowMs))).resolves.toEqual({
          detail: 'icp_candidate:deferred:deferred',
        });
        await expect(candidateStore.listCandidates()).resolves.toEqual([
          expect.objectContaining({
            status: 'deferred',
            retryAttempt: 1,
            retryEligibleAtMs: nowMs + RETRY_COOLDOWN_MS,
          }),
        ]);
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const restartedHandler = await createHandler(candidateStore);
        nowMs += 60_000;
        await expect(restartedHandler(makeAction(pending.id, 'before-cooldown', nowMs)))
          .resolves.toEqual({ detail: 'icp_candidate:deduped:deferred' });
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();

        nowMs += RETRY_COOLDOWN_MS - 60_000;
        await expect(restartedHandler(makeAction(pending.id, 'at-cooldown', nowMs)))
          .resolves.toEqual({ detail: 'icp_candidate:sent:consumed' });
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          activatedAt: new Date(nowMs).toISOString(),
          activationReason: 'icp_candidate_sent',
        });
        const candidates = await candidateStore.listCandidates();
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          status: 'consumed',
          retryAttempt: 1,
          deliveryDisposition: 'delivered',
        });
        expect(preflight).toHaveBeenCalledTimes(2);
        expect(consent).toHaveBeenCalledOnce();
        expect(issuePermit).toHaveBeenCalledOnce();
        expect(delivery).toHaveBeenCalledOnce();
      } finally {
        if (candidateStore) await candidateStore.close();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'dampens a suppressed pending follow-up and never opens a second target turn',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_suppressed_dampening';
      let nowMs = Date.parse('2026-07-14T04:00:00.000Z');
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-suppressed-dampening',
        allowExitOnIdle: true,
        max: 4,
        schema,
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-suppressed-dampening-'));
      tempDirs.push(dataDir);
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, { schema });
        const ports = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date(nowMs),
          idFactory: () => 'pending-follow-up-suppressed',
        });
        const pending = await ports.pendingFollowUpStore.enqueue({
          content: 'Dampen this source if target delivery is suppressed.',
          priority: 'medium',
          timing: 'immediate',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'retry-lifecycle-source',
        });
        if (!pending) throw new Error('pending follow-up was not created');

        const preflight = vi.fn().mockResolvedValue({ eligible: true as const });
        const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
        const issuePermit = vi.fn().mockImplementation(async ({ candidate }) => ({
          decision: { eligible: true as const },
          permit: {
            permitId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            candidateId: candidate.candidateId,
            conversationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            senderCompanionId: LOCAL_COMPANION_ID,
            recipientCompanionId: PEER_COMPANION_ID,
            channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 60_000,
            status: 'issued' as const,
            revision: 1,
          },
        }));
        const delivery = vi.fn().mockResolvedValue({ disposition: 'suppressed' as const });
        const peers = {
          resolveKnownPeer: vi.fn().mockResolvedValue({
            contactId: 'peer-contact',
            displayName: 'Peer',
            peerCompanionId: PEER_COMPANION_ID,
          }),
          executeCompanionOutreach: delivery,
        };
        const createHandler = async (store: PostgresIcpInitiationCandidateStore) => {
          const sourceRuntime = createIcpInitiationSourceRuntime({
            localCompanionId: LOCAL_COMPANION_ID,
            store,
            peers,
            gateway: {
              companionInitiationPreflight: preflight,
              companionIssueInitiationPermit: issuePermit,
            },
            consent: { evaluate: consent },
            isExternalCompanionAuthorized: () => true,
            now: () => nowMs,
          });
          return await wireOutboundHandler({
            dataDir,
            adapter: createIcpIntentionCandidateAdapter({
              sourceRuntime,
              peers,
              pendingFollowUpStore: ports.pendingFollowUpStore,
              concernStore: ports.concernStore,
              now: () => nowMs,
            }),
            pendingFollowUpStore: ports.pendingFollowUpStore,
            onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => (
              await ports.pendingFollowUpStore.dequeue(pendingFollowUpId, {
                ...(activationReason ? { activationReason } : {}),
              })
            ) !== null,
            onIntentionFollowUpDampened: async ({ pendingFollowUpId, dampeningReason }) => {
              const dampened = await ports.pendingFollowUpStore.dampen?.(
                pendingFollowUpId,
                { dampeningReason },
              );
              return dampened != null;
            },
          });
        };

        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const firstHandler = await createHandler(candidateStore);
        await expect(firstHandler(makeAction(pending.id, 'suppressed-first', nowMs)))
          .resolves.toEqual({ detail: 'icp_candidate:suppressed:consumed' });
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          dampenedAt: new Date(nowMs).toISOString(),
          dampeningReason: 'icp_candidate_suppressed',
        });
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty('activatedAt');

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        nowMs += 60_000;
        const restartedHandler = await createHandler(candidateStore);
        await expect(restartedHandler(makeAction(pending.id, 'suppressed-after-restart', nowMs)))
          .resolves.toEqual({ detail: 'blocked:stale_pending_follow_up' });
        const candidates = await candidateStore.listCandidates();
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          status: 'consumed',
          deliveryDisposition: 'suppressed',
        });
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).toHaveBeenCalledOnce();
        expect(issuePermit).toHaveBeenCalledOnce();
        expect(delivery).toHaveBeenCalledOnce();
      } finally {
        if (candidateStore) await candidateStore.close();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
