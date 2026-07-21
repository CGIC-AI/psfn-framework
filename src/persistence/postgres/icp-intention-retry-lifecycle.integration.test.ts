import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { wireReflectionRuntime } from '../../app/startup/composition/parity.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import {
  createIcpTargetChannelInitiator,
  type IcpDeliveryObservation,
} from '../../app/agent/icp-target-channel-initiation.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import type { IcpInitiationPermit } from '../../shared/contracts/icp-autonomy.js';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import type {
  PostTurnActionHandler,
  PostTurnActionQueueStatus,
  PostTurnActionRuntime,
} from '../../core/agent/post-turn-action-runtime.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import type { IcpInitiationCandidateStorePort } from '../../core/icp/autonomy-store-ports.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../../core/intention/appraisal.js';
import { createFileOutreachOutboxStore } from '../../core/intention/outreach-outbox.js';
import { createPostgresIntentionPortsFromPool } from '../../core/intention/postgres-adapters.js';
import type {
  ReflectionAgent,
  ReflectionRuntimeOptions,
} from '../../core/scheduler/reflection-runtime-contracts.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  createPostgresPool,
  runPostgresMigrations,
} from '../postgres.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const RETRY_COOLDOWN_MS = 5 * 60_000;
const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: PostgresTestHarness | null = null;
const tempDirs: string[] = [];

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
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
    ReflectionRuntimeOptions['onIntentionFollowUpActivated']
  >;
  onIntentionFollowUpDampened: NonNullable<
    ReflectionRuntimeOptions['onIntentionFollowUpDampened']
  >;
}): Promise<PostTurnActionHandler> {
  const handlers = new Map<string, PostTurnActionHandler>();
  const postTurnActions: PostTurnActionRuntime = {
    enqueue: () => 'queued',
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
  const agentLoop: ReflectionAgent = {
    handleMessage: vi.fn(async () => ({ content: '' })),
    followUp: vi.fn(),
    registerPostTurnActionInferer: vi.fn(() => () => undefined),
  };
  const llmProvider: LLMProviderPort = {
    stream: vi.fn(),
    complete: vi.fn(),
  };
  await wireReflectionRuntime(
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

async function wireOutboundQueue(options: {
  dataDir: string;
  persistencePath: string;
  adapter: ReturnType<typeof createIcpIntentionCandidateAdapter>;
  pendingFollowUpStore: ReturnType<typeof createPostgresIntentionPortsFromPool>['pendingFollowUpStore'];
  onIntentionFollowUpActivated: NonNullable<
    ReflectionRuntimeOptions['onIntentionFollowUpActivated']
  >;
  onIntentionFollowUpDampened: NonNullable<
    ReflectionRuntimeOptions['onIntentionFollowUpDampened']
  >;
}) {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 50,
    heartbeatIntervalMs: 1_000,
  });
  const agentLoop: ReflectionAgent = {
    handleMessage: vi.fn(async () => ({ content: '' })),
    followUp: vi.fn(),
    waitForIdle: vi.fn(),
    registerPostTurnActionInferer: vi.fn(() => () => undefined),
  };
  const postTurnActions = wirePostTurnActionRuntime({
    eventBus,
    scheduler,
    agentLoop,
    intervalMs: 1,
    persistencePath: options.persistencePath,
  });
  await wireReflectionRuntime(
    { registerTool: vi.fn() },
    scheduler,
    agentLoop,
    { send: vi.fn() },
    options.dataDir,
    undefined,
    {
      eventBus,
      postTurnActions,
      llmProvider: { stream: vi.fn(), complete: vi.fn() },
      pendingFollowUpStore: options.pendingFollowUpStore,
      onIntentionFollowUpActivated: options.onIntentionFollowUpActivated,
      onIntentionFollowUpDampened: options.onIntentionFollowUpDampened,
      outreachOutbox: createFileOutreachOutboxStore(
        join(options.dataDir, 'outreach-outbox.jsonl'),
      ),
      icpIntentionCandidateAdapter: options.adapter,
    },
  );
  return { eventBus, scheduler, postTurnActions };
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

async function enqueueAction(
  eventBus: EventBus,
  action: InferredPostTurnAction,
): Promise<void> {
  await eventBus.emit('agent.post_turn.actions.inferred', {
    message: {
      id: action.sourceMessageId,
      channelId: action.channelId,
      channelType: 'api',
      authorId: 'system:test',
      authorName: 'Integration Test',
      content: 'Queue one durable ICP intention action.',
      timestamp: new Date(action.inferredAt),
    },
    response: {
      channelId: action.channelId,
      content: '',
      metadata: {
        model: 'deterministic-test-model',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        turnId: 'retry-lifecycle-turn',
        requestId: action.sourceMessageId,
      },
    },
    actions: [action],
  });
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
    'persists one queued peer_busy candidate across restart until retry exhaustion dampens it',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_durable_queue_retry';
      let nowMs = Date.parse('2026-07-14T03:00:00.000Z');
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-durable-queue-retry',
        allowExitOnIdle: true,
        max: 4,
        schema,
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-durable-queue-retry-'));
      tempDirs.push(dataDir);
      const queuePath = join(dataDir, 'post-turn-actions.json');
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, { schema });
        const ports = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date(nowMs),
          idFactory: () => 'pending-follow-up-durable-queue-retry',
        });
        const pending = await ports.pendingFollowUpStore.enqueue({
          content: 'Retry this peer outreach until its durable retry budget is exhausted.',
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
        const activateFollowUp: NonNullable<
          ReflectionRuntimeOptions['onIntentionFollowUpActivated']
        > = async ({ pendingFollowUpId, activationReason }) => (
          await ports.pendingFollowUpStore.dequeue(pendingFollowUpId, {
            ...(activationReason ? { activationReason } : {}),
          })
        ) !== null;
        const dampenFollowUp: NonNullable<
          ReflectionRuntimeOptions['onIntentionFollowUpDampened']
        > = async ({ pendingFollowUpId, dampeningReason }) => {
          const dampened = await ports.pendingFollowUpStore.dampen?.(
            pendingFollowUpId,
            { dampeningReason },
          );
          return dampened != null;
        };
        const createQueue = async (store: PostgresIcpInitiationCandidateStore) => {
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
          return await wireOutboundQueue({
            dataDir,
            persistencePath: queuePath,
            adapter: createIcpIntentionCandidateAdapter({
              sourceRuntime,
              peers,
              candidateStore: store,
              pendingFollowUpStore: ports.pendingFollowUpStore,
              concernStore: ports.concernStore,
              now: () => nowMs,
            }),
            pendingFollowUpStore: ports.pendingFollowUpStore,
            onIntentionFollowUpActivated: activateFollowUp,
            onIntentionFollowUpDampened: dampenFollowUp,
          });
        };

        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const action = makeAction(pending.id, 'durable-queue', nowMs);
        const firstQueue = await createQueue(candidateStore);
        await enqueueAction(firstQueue.eventBus, action);
        await firstQueue.scheduler.tick();
        await expect(candidateStore.listCandidates()).resolves.toEqual([
          expect.objectContaining({
            status: 'deferred',
            retryAttempt: 1,
            retryEligibleAtMs: nowMs + RETRY_COOLDOWN_MS,
          }),
        ]);
        await expect(candidateStore.getCandidateByPendingFollowUpId(pending.id)).resolves
          .toMatchObject({ status: 'deferred', pendingFollowUpId: pending.id });
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();
        expect(firstQueue.postTurnActions.listQueued()).toEqual([
          expect.objectContaining({
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            attempt: 0,
            nextRunAt: nowMs + RETRY_COOLDOWN_MS,
          }),
        ]);

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        const restartedQueue = await createQueue(candidateStore);
        expect(restartedQueue.postTurnActions.getStatus().persistence).toMatchObject({
          loadState: 'loaded',
          loadedEntries: 1,
        });
        expect(restartedQueue.postTurnActions.listQueued()).toEqual([
          expect.objectContaining({
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            nextRunAt: nowMs + RETRY_COOLDOWN_MS,
          }),
        ]);

        nowMs += 60_000;
        await restartedQueue.scheduler.tick();
        expect(preflight).toHaveBeenCalledOnce();
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty(
          'activatedAt',
        );

        nowMs += RETRY_COOLDOWN_MS - 60_000;
        await restartedQueue.scheduler.tick();
        nowMs += RETRY_COOLDOWN_MS;
        await restartedQueue.scheduler.tick();
        nowMs += RETRY_COOLDOWN_MS;
        await restartedQueue.scheduler.tick();

        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          dampenedAt: new Date(nowMs).toISOString(),
          dampeningReason: 'icp_candidate_retry_exhausted',
        });
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty(
          'activatedAt',
        );
        const candidates = await candidateStore.listCandidates();
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
          status: 'cancelled',
          retryAttempt: 3,
          reasonCode: 'peer_busy',
        });
        expect(preflight).toHaveBeenCalledTimes(4);
        expect(consent).not.toHaveBeenCalled();
        expect(issuePermit).not.toHaveBeenCalled();
        expect(delivery).not.toHaveBeenCalled();
        expect(restartedQueue.postTurnActions.listQueued()).toEqual([]);
        expect(restartedQueue.postTurnActions.getStatus().completions.recentCompletions[0])
          .toMatchObject({
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            detail: 'icp_candidate:deferred:cancelled',
          });
      } finally {
        nowSpy.mockRestore();
        if (candidateStore) await candidateStore.close();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'reconciles a durably suppressed target after a crash before the Postgres candidate transition',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is unavailable');
      const database = await harness.createDatabase();
      const schema = 'companion_icp_suppression_crash_cut';
      const nowMs = Date.parse('2026-07-14T03:30:00.000Z');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      const pool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-icp-suppression-crash-cut',
        allowExitOnIdle: true,
        max: 4,
        schema,
      });
      const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-suppression-crash-cut-'));
      tempDirs.push(dataDir);
      let candidateStore: PostgresIcpInitiationCandidateStore | null = null;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, { schema });
        const ports = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date(nowMs),
          idFactory: () => 'pending-follow-up-suppression-crash-cut',
        });
        const pending = await ports.pendingFollowUpStore.enqueue({
          content: 'Recover this target suppression without opening another target turn.',
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

        let durableObservation: IcpDeliveryObservation | null = null;
        let currentPermit: IcpInitiationPermit | null = null;
        let rootInitiationId: string | null = null;
        const targetHandleMessage = vi.fn(async (message, deliveryLifecycle) => {
          const correlation = message.routing?.icpCorrelation;
          if (!correlation) throw new Error('target test turn is missing ICP correlation');
          const response = {
            content: '',
            channelId: message.channelId,
            metadata: {
              model: 'deterministic-test-model',
              inputTokens: 1,
              outputTokens: 0,
              durationMs: 1,
              turnId: correlation.turnId,
              requestId: correlation.requestId,
              icpCorrelation: correlation,
            },
          };
          await deliveryLifecycle.finalizeDelivery(response);
          return response;
        });
        const consumeInitiationPermit = vi.fn(async () => {
          if (!currentPermit) throw new Error('target test permit is unavailable');
          currentPermit = {
            ...currentPermit,
            status: 'consumed',
            consumedAtMs: nowMs,
            revision: currentPermit.revision + 1,
          };
          return { outcome: 'consumed' as const };
        });
        const sendInitiation = vi.fn();
        const createTargetInitiator = () => createIcpTargetChannelInitiator({
          localCompanionId: LOCAL_COMPANION_ID,
          agent: {
            handleMessage: targetHandleMessage,
            findRecordedIcpInitiation: vi.fn(async () => null),
            findIcpDeliveryObservation: vi.fn(async () => (
              durableObservation ? structuredClone(durableObservation) : null
            )),
            recordIcpDeliveryObservation: vi.fn(async (observation) => {
              durableObservation = structuredClone(observation);
            }),
          },
          gateway: { sendInitiation, consumeInitiationPermit },
        });
        let targetInitiator = createTargetInitiator();

        const preflight = vi.fn().mockResolvedValue({ eligible: true as const });
        const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
        const issuePermit = vi.fn().mockImplementation(async ({ candidate }) => {
          rootInitiationId = candidate.rootInitiationId;
          currentPermit = {
            permitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            candidateId: candidate.candidateId,
            conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            senderCompanionId: LOCAL_COMPANION_ID,
            recipientCompanionId: PEER_COMPANION_ID,
            channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 60_000,
            status: 'issued',
            revision: 1,
          };
          return { decision: { eligible: true as const }, permit: currentPermit };
        });
        const executeCompanionOutreach = vi.fn(async (_contactId, permitId) => {
          if (!currentPermit || currentPermit.permitId !== permitId || !rootInitiationId) {
            throw new Error('target test execution is missing its exact permit binding');
          }
          const result = await targetInitiator.initiate({
            permit: currentPermit,
            rootInitiationId,
            peerContactId: 'peer-contact',
          });
          return { disposition: result.disposition };
        });
        const peers = {
          resolveKnownPeer: vi.fn().mockResolvedValue({
            contactId: 'peer-contact',
            displayName: 'Peer',
            peerCompanionId: PEER_COMPANION_ID,
          }),
          executeCompanionOutreach,
        };
        const createHandler = async (store: IcpInitiationCandidateStorePort) => {
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
              candidateStore: store,
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
            onIntentionFollowUpDampened: async ({ pendingFollowUpId, dampeningReason }) => (
              await ports.pendingFollowUpStore.dampen?.(
                pendingFollowUpId,
                { dampeningReason },
              )
            ) != null,
          });
        };

        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        let injectCrash = true;
        const crashCutStore: IcpInitiationCandidateStorePort = {
          createCandidate: candidate => candidateStore!.createCandidate(candidate),
          getCandidate: candidateId => candidateStore!.getCandidate(candidateId),
          getCandidateByPendingFollowUpId: pendingFollowUpId => (
            candidateStore!.getCandidateByPendingFollowUpId(pendingFollowUpId)
          ),
          listCandidates: options => candidateStore!.listCandidates(options),
          async transitionCandidate(input) {
            if (injectCrash && input.status === 'consumed') {
              injectCrash = false;
              throw new Error('injected crash after durable target suppression');
            }
            return await candidateStore!.transitionCandidate(input);
          },
          async close() {},
        };
        const action = makeAction(pending.id, 'suppression-crash-cut', nowMs);
        const firstHandler = await createHandler(crashCutStore);
        await expect(firstHandler(action)).rejects.toThrow(
          'injected crash after durable target suppression',
        );
        expect(durableObservation).toMatchObject({
          status: 'suppressed',
          turnCompleted: true,
        });
        await expect(candidateStore.listCandidates()).resolves.toEqual([
          expect.objectContaining({ status: 'permitted' }),
        ]);
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty(
          'dampenedAt',
        );

        await candidateStore.close();
        candidateStore = await PostgresIcpInitiationCandidateStore.connect(
          database.databaseUrl,
          { schema },
        );
        targetInitiator = createTargetInitiator();
        const restartedHandler = await createHandler(candidateStore);
        await expect(restartedHandler(action)).resolves.toEqual({
          detail: 'icp_candidate:suppressed:consumed',
        });

        expect(targetHandleMessage).toHaveBeenCalledOnce();
        expect(consumeInitiationPermit).toHaveBeenCalledOnce();
        expect(sendInitiation).not.toHaveBeenCalled();
        expect(executeCompanionOutreach).toHaveBeenCalledTimes(2);
        await expect(candidateStore.listCandidates()).resolves.toEqual([
          expect.objectContaining({
            status: 'consumed',
            deliveryDisposition: 'suppressed',
          }),
        ]);
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.toMatchObject({
          dampenedAt: new Date(nowMs).toISOString(),
          dampeningReason: 'icp_candidate_suppressed',
        });
        await expect(ports.pendingFollowUpStore.peek(pending.id)).resolves.not.toHaveProperty(
          'activatedAt',
        );
      } finally {
        nowSpy.mockRestore();
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
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
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
              candidateStore,
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
        nowSpy.mockRestore();
        if (candidateStore) await candidateStore.close();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
