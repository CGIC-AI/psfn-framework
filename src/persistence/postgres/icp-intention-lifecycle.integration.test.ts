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
import type {
  HeartbeatAgent,
  HeartbeatRuntimeOptions,
} from '../../core/scheduler/heartbeat-runtime-contracts.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../../core/intention/appraisal.js';
import {
  createFileOutreachOutboxStore,
  type OutreachOutboxStore,
} from '../../core/intention/outreach-outbox.js';
import { createPostgresIntentionPortsFromPool } from '../../core/intention/postgres-adapters.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import type { IcpInitiationCandidateStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { IcpInitiationCandidate } from '../../core/icp/initiation-candidate.js';
import {
  createPostgresPool,
  runPostgresMigrations,
} from '../postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: PostgresTestHarness | null = null;
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

function candidateStore(): IcpInitiationCandidateStorePort {
  const candidates = new Map<string, IcpInitiationCandidate>();
  return {
    async createCandidate(candidate) {
      const existing = candidates.get(candidate.candidateId);
      if (existing) return existing;
      candidates.set(candidate.candidateId, structuredClone(candidate));
      return structuredClone(candidate);
    },
    async getCandidate(candidateId) {
      const candidate = candidates.get(candidateId);
      return candidate ? structuredClone(candidate) : null;
    },
    async getCandidateByPendingFollowUpId(pendingFollowUpId) {
      const candidate = [...candidates.values()].find(
        row => row.pendingFollowUpId === pendingFollowUpId,
      );
      return candidate ? structuredClone(candidate) : null;
    },
    async listCandidates() {
      return [...candidates.values()].map(candidate => structuredClone(candidate));
    },
    async transitionCandidate(input) {
      const current = candidates.get(input.candidateId);
      if (!current
        || current.status !== input.expectedStatus
        || current.revision !== input.expectedRevision) {
        throw new Error('candidate transition conflict');
      }
      const next: IcpInitiationCandidate = {
        ...current,
        status: input.status,
        revision: current.revision + 1,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.permitId ? { permitId: input.permitId } : {}),
        ...(input.deliveryDisposition
          ? { deliveryDisposition: input.deliveryDisposition }
          : {}),
        ...(input.retryAttempt !== undefined ? { retryAttempt: input.retryAttempt } : {}),
        ...(input.retryEligibleAtMs !== undefined
          ? { retryEligibleAtMs: input.retryEligibleAtMs }
          : {}),
      };
      if (input.status !== 'deferred' || input.clearRetryEligibility === true) {
        delete next.retryEligibleAtMs;
      }
      candidates.set(next.candidateId, structuredClone(next));
      return structuredClone(next);
    },
    async close() {},
  };
}

async function wireOutboundHandler(options: {
  dataDir: string;
  adapter: ReturnType<typeof createIcpIntentionCandidateAdapter>;
  pendingFollowUpStore: ReturnType<typeof createPostgresIntentionPortsFromPool>['pendingFollowUpStore'];
  outreachOutbox: OutreachOutboxStore;
  onIntentionFollowUpActivated: NonNullable<
    HeartbeatRuntimeOptions['onIntentionFollowUpActivated']
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
      outreachOutbox: options.outreachOutbox,
      icpIntentionCandidateAdapter: options.adapter,
    },
  );
  const handler = handlers.get(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND);
  if (!handler) throw new Error('intention outbound handler was not registered');
  return handler;
}

describe('Postgres ICP intention lifecycle recovery', () => {
  it(
    'reconciles failed follow-up activation after restart without repeating consent or delivery',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-intention-lifecycle-recovery',
        allowExitOnIdle: true,
        max: 4,
        schema: 'companion_icp_intention_recovery',
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-intention-recovery-'));
      tempDirs.push(dataDir);
      const outboxPath = join(dataDir, 'outreach-outbox.jsonl');
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_icp_intention_recovery',
        });
        const firstPorts = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-14T01:00:00.000Z'),
          idFactory: () => 'pending-follow-up-recovery',
        });
        const pending = await firstPorts.pendingFollowUpStore.enqueue({
          content: 'Reach out to the peer once.',
          priority: 'medium',
          timing: 'immediate',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'source-before-restart',
        });
        if (!pending) throw new Error('pending follow-up was not created');

        const store = candidateStore();
        const createCandidate = vi.spyOn(store, 'createCandidate');
        const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
        const preflight = vi.fn().mockResolvedValue({ eligible: true as const });
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
            issuedAtMs: Date.parse('2026-07-14T01:00:00.000Z'),
            expiresAtMs: Date.parse('2026-07-14T01:05:00.000Z'),
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
          now: () => Date.parse('2026-07-14T01:00:00.000Z'),
        });
        const firstAdapter = createIcpIntentionCandidateAdapter({
          sourceRuntime,
          peers,
          candidateStore: store,
          pendingFollowUpStore: firstPorts.pendingFollowUpStore,
          concernStore: firstPorts.concernStore,
          now: () => Date.parse('2026-07-14T01:00:00.000Z'),
        });
        let activationAttempts = 0;
        const firstHandler = await wireOutboundHandler({
          dataDir,
          adapter: firstAdapter,
          pendingFollowUpStore: firstPorts.pendingFollowUpStore,
          outreachOutbox: createFileOutreachOutboxStore(outboxPath),
          onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => {
            activationAttempts += 1;
            if (activationAttempts === 1) {
              throw new Error('injected PostgreSQL activation failure');
            }
            return (await firstPorts.pendingFollowUpStore.dequeue(pendingFollowUpId, {
              ...(activationReason ? { activationReason } : {}),
            })) !== null;
          },
        });
        const firstAction = {
          id: 'first-action',
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          dedupeKey: 'intention.outbound_message:first-action',
          channelId: 'api:test',
          sourceMessageId: 'source-before-restart',
          inferredAt: Date.parse('2026-07-14T01:00:00.000Z'),
          payload: {
            channelId: 'api:test',
            channelType: 'api',
            content: 'Private peer outreach candidate.',
            pendingFollowUpId: pending.id,
          },
        } satisfies InferredPostTurnAction;

        await expect(firstHandler(firstAction)).rejects.toThrow('injected PostgreSQL activation failure');
        await expect(firstPorts.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty('activatedAt');
        expect(createFileOutreachOutboxStore(outboxPath)
          .getIcpDeliveredCompletion(pending.id)).toBeDefined();

        const restartedPorts = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-14T01:01:00.000Z'),
        });
        const restartedAdapter = createIcpIntentionCandidateAdapter({
          sourceRuntime,
          peers,
          candidateStore: store,
          pendingFollowUpStore: restartedPorts.pendingFollowUpStore,
          concernStore: restartedPorts.concernStore,
          now: () => Date.parse('2026-07-14T01:01:00.000Z'),
        });
        const restartedHandler = await wireOutboundHandler({
          dataDir,
          adapter: restartedAdapter,
          pendingFollowUpStore: restartedPorts.pendingFollowUpStore,
          outreachOutbox: createFileOutreachOutboxStore(outboxPath),
          onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => (
            await restartedPorts.pendingFollowUpStore.dequeue(pendingFollowUpId, {
              ...(activationReason ? { activationReason } : {}),
            })
          ) !== null,
        });
        await expect(restartedHandler({
          ...firstAction,
          id: 'new-action-after-restart',
          dedupeKey: 'intention.outbound_message:new-action-after-restart',
          inferredAt: Date.parse('2026-07-14T01:01:00.000Z'),
        })).resolves.toEqual({ detail: 'icp_candidate:delivery_reconciled' });

        await expect(restartedPorts.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          activatedAt: '2026-07-14T01:01:00.000Z',
          activationReason: 'icp_candidate_sent',
        });
        expect(createCandidate).toHaveBeenCalledOnce();
        expect(consent).toHaveBeenCalledOnce();
        expect(preflight).toHaveBeenCalledOnce();
        expect(issuePermit).toHaveBeenCalledOnce();
        expect(delivery).toHaveBeenCalledOnce();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'recovers a crash before the delivery marker without repeating the durable ICP pipeline',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_delivery_marker_recovery';
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-delivery-marker-recovery',
        allowExitOnIdle: true,
        max: 4,
        schema,
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-delivery-marker-recovery-'));
      tempDirs.push(dataDir);
      const outboxPath = join(dataDir, 'outreach-outbox.jsonl');
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, { schema });
        const firstPorts = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-14T02:00:00.000Z'),
          idFactory: () => 'pending-follow-up-marker-recovery',
        });
        const pending = await firstPorts.pendingFollowUpStore.enqueue({
          content: 'Reach out once despite a local completion-ledger crash.',
          priority: 'medium',
          timing: 'immediate',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'source-before-marker-crash',
        });
        if (!pending) throw new Error('pending follow-up was not created');

        const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
        const preflight = vi.fn().mockResolvedValue({ eligible: true as const });
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
            issuedAtMs: Date.parse('2026-07-14T02:00:00.000Z'),
            expiresAtMs: Date.parse('2026-07-14T02:05:00.000Z'),
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
        const createSourceRuntime = (store: PostgresIcpInitiationCandidateStore, nowMs: number) => (
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

        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const firstAdapter = createIcpIntentionCandidateAdapter({
          sourceRuntime: createSourceRuntime(
            candidateStore,
            Date.parse('2026-07-14T02:00:00.000Z'),
          ),
          peers,
          candidateStore,
          pendingFollowUpStore: firstPorts.pendingFollowUpStore,
          concernStore: firstPorts.concernStore,
          now: () => Date.parse('2026-07-14T02:00:00.000Z'),
        });
        const durableOutbox = createFileOutreachOutboxStore(outboxPath);
        let injectMarkerFailure = true;
        const failingOutbox: OutreachOutboxStore = {
          append(record) {
            if (injectMarkerFailure
              && record.phase === 'sent'
              && record.metadata?.kind === 'icp_candidate_delivery') {
              injectMarkerFailure = false;
              throw new Error('injected failure before ICP delivery completion marker append');
            }
            durableOutbox.append(record);
          },
          hasTerminal: dedupeKey => durableOutbox.hasTerminal(dedupeKey),
          getTerminal: dedupeKey => durableOutbox.getTerminal(dedupeKey),
          getIcpDeliveredCompletion: pendingFollowUpId => (
            durableOutbox.getIcpDeliveredCompletion(pendingFollowUpId)
          ),
        };
        const firstHandler = await wireOutboundHandler({
          dataDir,
          adapter: firstAdapter,
          pendingFollowUpStore: firstPorts.pendingFollowUpStore,
          outreachOutbox: failingOutbox,
          onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => (
            await firstPorts.pendingFollowUpStore.dequeue(pendingFollowUpId, {
              ...(activationReason ? { activationReason } : {}),
            })
          ) !== null,
        });
        const firstAction = {
          id: 'marker-crash-first-action',
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          dedupeKey: 'intention.outbound_message:marker-crash-first-action',
          channelId: 'api:test',
          sourceMessageId: 'source-before-marker-crash',
          inferredAt: Date.parse('2026-07-14T02:00:00.000Z'),
          payload: {
            channelId: 'api:test',
            channelType: 'api',
            content: 'Private peer outreach candidate with durable completion recovery.',
            pendingFollowUpId: pending.id,
          },
        } satisfies InferredPostTurnAction;

        await expect(firstHandler(firstAction)).rejects.toThrow(
          'injected failure before ICP delivery completion marker append',
        );
        await expect(firstPorts.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty('activatedAt');
        expect(createFileOutreachOutboxStore(outboxPath)
          .getIcpDeliveredCompletion(pending.id)).toBeUndefined();
        await expect(candidateStore.listCandidates()).resolves.toEqual([
          expect.objectContaining({
            status: 'consumed',
            pendingFollowUpId: pending.id,
            deliveryDisposition: 'delivered',
          }),
        ]);

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const restartedPorts = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-14T02:01:00.000Z'),
        });
        const restartedAdapter = createIcpIntentionCandidateAdapter({
          sourceRuntime: createSourceRuntime(
            candidateStore,
            Date.parse('2026-07-14T02:01:00.000Z'),
          ),
          peers,
          candidateStore,
          pendingFollowUpStore: restartedPorts.pendingFollowUpStore,
          concernStore: restartedPorts.concernStore,
          now: () => Date.parse('2026-07-14T02:01:00.000Z'),
        });
        const restartedHandler = await wireOutboundHandler({
          dataDir,
          adapter: restartedAdapter,
          pendingFollowUpStore: restartedPorts.pendingFollowUpStore,
          outreachOutbox: createFileOutreachOutboxStore(outboxPath),
          onIntentionFollowUpActivated: async ({ pendingFollowUpId, activationReason }) => (
            await restartedPorts.pendingFollowUpStore.dequeue(pendingFollowUpId, {
              ...(activationReason ? { activationReason } : {}),
            })
          ) !== null,
        });

        await expect(restartedHandler(firstAction)).resolves.toEqual({
          detail: 'icp_candidate:deduped:consumed',
        });
        await expect(restartedPorts.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          activatedAt: '2026-07-14T02:01:00.000Z',
          activationReason: 'icp_candidate_sent',
        });
        expect(createFileOutreachOutboxStore(outboxPath)
          .getIcpDeliveredCompletion(pending.id)).toBeDefined();

        await expect(restartedHandler({
          ...firstAction,
          id: 'marker-crash-new-action-after-restart',
          dedupeKey: 'intention.outbound_message:marker-crash-new-action-after-restart',
          inferredAt: Date.parse('2026-07-14T02:02:00.000Z'),
        })).resolves.toEqual({ detail: 'icp_candidate:delivery_reconciled' });
        const count = await pool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM icp_initiation_candidates',
        );
        expect(count.rows[0]?.count).toBe('1');
        expect(consent).toHaveBeenCalledOnce();
        expect(preflight).toHaveBeenCalledOnce();
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
