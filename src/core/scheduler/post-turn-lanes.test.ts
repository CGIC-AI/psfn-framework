import { fromAny } from '@total-typescript/shoehorn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wireReflectionRuntime } from '../../app/startup/composition/parity.js';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import {
  BACKGROUND_MAINTENANCE_TASK_ID,
  BackgroundMaintenanceRegistry,
} from './background-maintenance.js';
import { Scheduler } from './scheduler.js';
import { SLEEPTIME_REST_WINDOW_OPERATION_ID } from './post-turn-runtime.js';
import { SLEEPTIME_MEMORY_ACTION_KIND } from '../../faculties/memory/sleeptime-agent.js';
import { NEAR_TURN_MEMORY_ACTION_KIND } from '../../faculties/memory/near-turn-memory-lane.js';
import {
  EPISODE_SYNTHESIS_ACTION_KIND,
  EPISODE_SYNTHESIS_TIMER_TASK_ID,
} from '../../faculties/memory/episodic/synthesis-lane.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeMessage(id: string, channelId = 'terminal:lane-test'): SubstrateMessage {
  return {
    id,
    channelId,
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'User',
    content: `turn ${id}`,
    timestamp: new Date(),
  };
}

function makeResponse(channelId = 'terminal:lane-test'): AgentResponse {
  return {
    content: 'ok',
    channelId,
    metadata: {
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
    },
  };
}

describe('reflection post-turn lane split (E5.2)', () => {
  function wireLanes(options: {
    fleetMaintenance?: {
      coordinator: Record<string, unknown>;
      leaseDurationMs: number;
      retryDelayMs: number;
    };
  } = {}) {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-lane-split-'));
    TEMP_DIRS.push(tempDir);
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 50,
      heartbeatIntervalMs: 1_000,
    });
    const backgroundMaintenance = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate: createEligibilityGate(() => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(),
        has: () => true,
      })),
      intervalMs: 3_600_000,
    });
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };
    const sleepConsolidator = { run: vi.fn() };
    const arcWeaver = { run: vi.fn() };
    const dreamMeaningPass = { run: vi.fn() };
    const sleeptimeWikiPass = { run: vi.fn() };
    const episodicSynthesizer = { run: vi.fn() };
    const episodicWatermarkStore = { getProcessingWatermark: vi.fn(async () => undefined) };
    const conversationalActivityWorkset = {
      enumerate: vi.fn().mockResolvedValue([]),
      claim: vi.fn(),
      resumeClaim: vi.fn(),
      checkpoint: vi.fn(),
    };
    const llmProvider = { stream: vi.fn(), complete: vi.fn() };
    const inferers: PostTurnActionInferer[] = [];

    void wireReflectionRuntime(
      { registerTool: vi.fn() },
      scheduler,
      fromAny({
        handleMessage: vi.fn(),
        followUp: vi.fn(),
        waitForIdle: vi.fn(),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      }),
      { send: vi.fn() },
      tempDir,
      undefined,
      {
        eventBus,
        backgroundMaintenance,
        postTurnActions: fromAny(postTurnActions),
        llmProvider: fromAny(llmProvider),
        memoryWriter: { write: vi.fn() },
        coreMemoryStore: fromAny({ getSnapshot: vi.fn(), rethink: vi.fn() }),
        episodicReviewStore: fromAny({ searchByTime: vi.fn().mockResolvedValue([]) }),
        sessionManager: fromAny({
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: vi.fn().mockReturnValue([]),
        }),
        episodicProcessingRestWindow: {
          enabled: true,
          startLocalTime: '00:00',
          endLocalTime: '09:00',
          timeZone: 'UTC',
          inactivityThresholdMinutes: 60,
        },
        nearTurnMemoryCadence: {
          direct: { cadenceTurns: 3 },
          group: { minIntervalMinutes: 15, minNewEntries: 8 },
        },
        episodeSynthesis: {
          daytimeSlots: ['09:00', '12:00', '15:00', '18:00'],
          timezone: 'local',
          turnThreshold: 5,
          minRelevantTurns: 10,
          transcriptMessageLimit: 96,
          maxEpisodesPerRun: 6,
          gapSplitMinutes: 45,
          maxEntriesPerEpisode: 14,
          minConversationalEntries: 2,
          minSingleEntryChars: 120,
        },
        episodicWatermarkStore: fromAny(episodicWatermarkStore),
        conversationalActivityWorkset: fromAny(conversationalActivityWorkset),
        fleetScheduleStagger: { manifestOrdinal: 1, fleetSize: 3 },
        ...(options.fleetMaintenance
          ? { fleetMaintenance: fromAny(options.fleetMaintenance) }
          : {}),
        companionNames: ['Companion'],
        companionAuthorIds: ['bot-1'],
        episodicSynthesizer,
        sleepConsolidator,
        arcWeaver,
        dreamMeaningPass,
        sleeptimeWikiPass,
        intentionAppraisalEnabled: false,
      },
    );

    const inferer = inferers.at(0);
    if (!inferer) {
      throw new Error('Post-turn action inferer was not registered');
    }
    return {
      scheduler,
      postTurnActions,
      conversationalActivityWorkset,
      sleepConsolidator,
      arcWeaver,
      dreamMeaningPass,
      episodicSynthesizer,
      llmProvider,
      inferer,
    };
  }

  it('never infers heavy sleeptime work from turn cadence (test-enforced unreachability)', async () => {
    const harness = wireLanes();

    const inferredKinds: string[] = [];
    for (let turn = 1; turn <= 12; turn += 1) {
      const inferred = await harness.inferer({
        message: makeMessage(`m${turn}`),
        response: makeResponse(),
        turnMessages: [],
      });
      inferredKinds.push(...inferred.map(action => action.kind));
    }

    // Turn cadence produces near-turn lane actions and gated episode-synthesis
    // evaluations only — never the heavy sleeptime action, and never a direct
    // heavy-pass invocation.
    expect(inferredKinds).not.toContain(SLEEPTIME_MEMORY_ACTION_KIND);
    expect(inferredKinds.filter(kind => kind === NEAR_TURN_MEMORY_ACTION_KIND)).toHaveLength(4);
    // turnThreshold=5 over 12 turns => two gate evaluations (the gate itself
    // runs in the handler, so no synthesis happens at inference time).
    expect(inferredKinds.filter(kind => kind === EPISODE_SYNTHESIS_ACTION_KIND)).toHaveLength(2);
    expect(harness.sleepConsolidator.run).not.toHaveBeenCalled();
    expect(harness.arcWeaver.run).not.toHaveBeenCalled();
    expect(harness.dreamMeaningPass.run).not.toHaveBeenCalled();
    expect(harness.episodicSynthesizer.run).not.toHaveBeenCalled();
    expect(harness.llmProvider.complete).not.toHaveBeenCalled();
  });

  it('registers the rest-window sleeptime task and gate timer in the scheduler task list', () => {
    const harness = wireLanes();
    const task = harness.scheduler.getTask(BACKGROUND_MAINTENANCE_TASK_ID);
    expect(task?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: SLEEPTIME_REST_WINDOW_OPERATION_ID }),
    ]));
    const timerTasks = harness.scheduler.listTasks()
      .filter(task => task.id.startsWith(`${EPISODE_SYNTHESIS_TIMER_TASK_ID}:`));
    expect(timerTasks).toHaveLength(4);
    expect(timerTasks.map(task => task.cadence)).toEqual([
      { kind: 'daily', hour: 9, minute: 0, timezone: 'local' },
      { kind: 'daily', hour: 12, minute: 0, timezone: 'local' },
      { kind: 'daily', hour: 15, minute: 0, timezone: 'local' },
      { kind: 'daily', hour: 18, minute: 0, timezone: 'local' },
    ]);
    expect(timerTasks.map(task => task.fleetStagger)).toEqual([
      { manifestOrdinal: 1, fleetSize: 3 },
      { manifestOrdinal: 1, fleetSize: 3 },
      { manifestOrdinal: 1, fleetSize: 3 },
      { manifestOrdinal: 1, fleetSize: 3 },
    ]);
    // The heavy sleeptime handler is registered for the scheduler-owned action
    // kind; the near-turn and episode-synthesis handlers are separate lanes.
    const registeredKinds = harness.postTurnActions.registerHandler.mock.calls.map(call => call[0]);
    expect(registeredKinds).toContain(SLEEPTIME_MEMORY_ACTION_KIND);
    expect(registeredKinds).toContain(NEAR_TURN_MEMORY_ACTION_KIND);
    expect(registeredKinds).toContain(EPISODE_SYNTHESIS_ACTION_KIND);
    expect(harness.postTurnActions.registerHandler.mock.calls.find(
      call => call[0] === EPISODE_SYNTHESIS_ACTION_KIND,
    )?.[2]).toMatchObject({
      coalescing: 'dedupe_key_with_durable_watermark',
    });
    expect(harness.scheduler.getTask('reflection:daily-review')?.fleetStagger).toEqual({
      manifestOrdinal: 1,
      fleetSize: 3,
    });
    expect(harness.scheduler.getTask('reflection:weekly-review')?.fleetStagger).toEqual({
      manifestOrdinal: 1,
      fleetSize: 3,
    });
  });

  it('runs the companion sleeptime action under the fleet baton', async () => {
    const lease = {
      companionId: '11111111-1111-4111-8111-111111111111',
      fencingToken: 1,
      acquiredAtMs: Date.now(),
      expiresAtMs: Date.now() + 5_000,
      phase: 'sleeptime',
      checkpointRef: null,
      preemptRequested: false,
    };
    const coordinator = {
      companionId: lease.companionId,
      manifestOrdinal: 0,
      fleetSize: 3,
      announceDemand: vi.fn(async () => undefined),
      tryAcquire: vi.fn(async () => ({ outcome: 'acquired', lease })),
      renew: vi.fn(),
      commitCheckpoint: vi.fn(),
      release: vi.fn(async () => undefined),
      requestForegroundPreemption: vi.fn(),
      withdrawDemand: vi.fn(),
      readCheckpoint: vi.fn(),
      close: vi.fn(),
    };
    const harness = wireLanes({
      fleetMaintenance: {
        coordinator,
        leaseDurationMs: 5_000,
        retryDelayMs: 1_000,
      },
    });
    const registration = harness.postTurnActions.registerHandler.mock.calls.find(
      call => call[0] === SLEEPTIME_MEMORY_ACTION_KIND,
    );
    const handler = registration?.[1];
    if (typeof handler !== 'function') throw new Error('Sleeptime handler was not registered');

    await expect(handler(fromAny({
      id: 'sleeptime-action',
      sourceMessageId: 'source-message',
      payload: { trigger: 'idle_rest_window' },
    }))).resolves.toMatchObject({ detail: 'Sleeptime completed 0 changed session(s)' });
    expect(coordinator.announceDemand).toHaveBeenCalledOnce();
    expect(coordinator.tryAcquire).toHaveBeenCalledOnce();
    expect(coordinator.release).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'complete' }));
  });

  it('runs episode synthesis under the fleet baton and checkpoints only after private progress', async () => {
    const lease = {
      companionId: '11111111-1111-4111-8111-111111111111',
      fencingToken: 2,
      acquiredAtMs: Date.now(),
      expiresAtMs: Date.now() + 5_000,
      phase: 'episode_synthesis',
      checkpointRef: null,
      preemptRequested: false,
    };
    const checkpointedLease = { ...lease, fencingToken: 2, phase: 'episode_synthesis' };
    const coordinator = {
      companionId: lease.companionId,
      manifestOrdinal: 0,
      fleetSize: 3,
      announceDemand: vi.fn(async () => undefined),
      tryAcquire: vi.fn(async () => ({ outcome: 'acquired', lease })),
      renew: vi.fn(),
      commitCheckpoint: vi.fn(async () => ({
        lease: checkpointedLease,
        disposition: 'yield_requested',
      })),
      release: vi.fn(async () => undefined),
      requestForegroundPreemption: vi.fn(),
      withdrawDemand: vi.fn(),
      readCheckpoint: vi.fn(),
      close: vi.fn(),
    };
    const harness = wireLanes({
      fleetMaintenance: {
        coordinator,
        leaseDurationMs: 5_000,
        retryDelayMs: 1_000,
      },
    });
    harness.conversationalActivityWorkset.enumerate.mockResolvedValueOnce([{
      purpose: 'episodic_synthesis',
      logicalSessionId: 'terminal:episode-baton',
      revision: 1,
      activityKind: 'direct_message',
      checkpointRevision: 0,
      completedStages: [],
    }]);
    harness.conversationalActivityWorkset.resumeClaim.mockResolvedValueOnce(null);
    harness.conversationalActivityWorkset.claim.mockResolvedValueOnce({
      purpose: 'episodic_synthesis',
      logicalSessionId: 'terminal:episode-baton',
      revision: 1,
      activityKind: 'direct_message',
      checkpointRevision: 0,
      completedStages: [],
      claimantId: 'episode-synthesis-drain',
      claimedAtMs: Date.now(),
    });
    harness.conversationalActivityWorkset.checkpoint.mockResolvedValueOnce(undefined);
    const registration = harness.postTurnActions.registerHandler.mock.calls.find(
      call => call[0] === EPISODE_SYNTHESIS_ACTION_KIND,
    );
    const handler = registration?.[1];
    if (typeof handler !== 'function') throw new Error('Episode synthesis handler was not registered');

    await expect(handler(fromAny({
      id: 'episode-action',
      channelId: 'terminal:episode-baton',
      sourceMessageId: 'source-message',
      payload: { trigger: 'timer' },
    }))).resolves.toMatchObject({
      detail: 'Episode synthesis yielded for fleet preemption',
    });

    expect(coordinator.announceDemand).toHaveBeenCalledOnce();
    expect(coordinator.tryAcquire).toHaveBeenCalledOnce();
    expect(harness.conversationalActivityWorkset.checkpoint).toHaveBeenCalledOnce();
    expect(coordinator.commitCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'episode_synthesis',
      checkpointRef: null,
    }));
    expect(harness.conversationalActivityWorkset.checkpoint.mock.invocationCallOrder[0])
      .toBeLessThan(coordinator.commitCheckpoint.mock.invocationCallOrder[0] ?? 0);
    expect(coordinator.release).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'yield' }));
  });
});
