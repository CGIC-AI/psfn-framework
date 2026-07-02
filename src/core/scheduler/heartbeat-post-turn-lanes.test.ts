import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wireHeartbeatRuntime } from '../../app/startup/composition/parity.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from './scheduler.js';
import { SLEEPTIME_REST_WINDOW_TASK_ID } from './heartbeat-post-turn-runtime.js';
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

describe('heartbeat post-turn lane split (E5.2)', () => {
  function wireLanes() {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-lane-split-'));
    TEMP_DIRS.push(tempDir);
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 50,
      heartbeatIntervalMs: 1_000,
    });
    const postTurnActions = {
      registerHandler: vi.fn().mockReturnValue(() => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };
    const sleepConsolidator = { run: vi.fn() };
    const arcWeaver = { run: vi.fn() };
    const dreamMeaningPass = { run: vi.fn() };
    const episodicSynthesizer = { run: vi.fn() };
    const episodicWatermarkStore = { getProcessingWatermark: vi.fn(async () => undefined) };
    const llmProvider = { stream: vi.fn(), complete: vi.fn() };
    const inferers: PostTurnActionInferer[] = [];

    wireHeartbeatRuntime(
      { registerTool: vi.fn() },
      scheduler,
      {
        handleMessage: vi.fn(),
        followUp: vi.fn(),
        waitForIdle: vi.fn(),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      } as any,
      { send: vi.fn() },
      tempDir,
      undefined,
      {
        eventBus,
        postTurnActions: postTurnActions as any,
        llmProvider: llmProvider as any,
        memoryWriter: { write: vi.fn() },
        coreMemoryStore: { getSnapshot: vi.fn(), rethink: vi.fn() } as any,
        sessionManager: {
          resolveSessionChannelId: (channelId: string) => channelId,
          getRecentMessages: vi.fn().mockReturnValue([]),
        } as any,
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
          timerIntervalMinutes: 30,
          turnThreshold: 5,
          minRelevantTurns: 10,
          transcriptMessageLimit: 96,
          maxEpisodesPerRun: 6,
          gapSplitMinutes: 45,
          maxEntriesPerEpisode: 14,
          minConversationalEntries: 2,
          minSingleEntryChars: 120,
        },
        episodicWatermarkStore: episodicWatermarkStore as any,
        companionNames: ['Purrsephone'],
        companionAuthorIds: ['bot-1'],
        episodicSynthesizer,
        sleepConsolidator,
        arcWeaver,
        dreamMeaningPass,
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
    const task = harness.scheduler.getTask(SLEEPTIME_REST_WINDOW_TASK_ID);
    expect(task).toBeDefined();
    expect(task?.name).toContain('Rest-Window');
    const timerTask = harness.scheduler.getTask(EPISODE_SYNTHESIS_TIMER_TASK_ID);
    expect(timerTask).toBeDefined();
    expect(timerTask?.intervalMs).toBe(30 * 60_000);
    // The heavy sleeptime handler is registered for the scheduler-owned action
    // kind; the near-turn and episode-synthesis handlers are separate lanes.
    const registeredKinds = harness.postTurnActions.registerHandler.mock.calls.map(call => call[0]);
    expect(registeredKinds).toContain(SLEEPTIME_MEMORY_ACTION_KIND);
    expect(registeredKinds).toContain(NEAR_TURN_MEMORY_ACTION_KIND);
    expect(registeredKinds).toContain(EPISODE_SYNTHESIS_ACTION_KIND);
  });
});
