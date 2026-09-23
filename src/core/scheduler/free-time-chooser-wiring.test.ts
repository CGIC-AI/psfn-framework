import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type {
  EpisodicProcessingRestWindowConfig,
  FreeTimeConfig,
} from '../../system/config/scheduler-config.js';
import type { SessionEntry } from '../session/types.js';
import { REFLECTION_SILENT_TOKEN } from './reflection-policy.js';
import { Scheduler } from './scheduler.js';
import {
  FREE_TIME_BLOCK_EVENT,
  FREE_TIME_IDLE_TASK_ID,
  registerFreeTimeTasks,
  freeTimeWorkspaceChannelId,
  type FreeTimeRuntimeOptions,
  type FreeTimeSessionManagerPort,
} from './free-time.js';
import { resolveFreeTimeWorkspace } from './free-time-workspace-resolver.js';
import type { FreeTimeChooserOutcome } from './free-time-chooser.js';

const restWindow: EpisodicProcessingRestWindowConfig = {
  enabled: true,
  startLocalTime: '00:00',
  endLocalTime: '09:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 180,
};

function freeTimeConfig(): FreeTimeConfig {
  return {
    enabled: true,
    minBlockIntervalMinutes: 240,
    maxBlocksPerDay: 3,
    seedText: 'You have some time to yourself.',
    quietHours: { enabled: false, checkIntervalMs: 1_000 },
    idle: { enabled: true, checkIntervalMs: 1_000, minIdleMinutes: 180 },
    budget: { maxTurns: 6, maxChargeUnits: 8 },
    returnNote: { summaryMaxTokens: 160 },
  };
}

const PRIVATE_WORKSPACE_OUTCOME: FreeTimeChooserOutcome = {
  kind: 'workspace',
  optionId: 'private_wander',
  label: 'Spend some unstructured private time',
  choice: { kind: 'private_wander' },
  workspace: resolveFreeTimeWorkspace(
    { kind: 'private_wander' },
    { projectDirectory: () => null, roomChannelResolver: () => null },
  ),
};

function buildRuntime(chooseWorkspace: FreeTimeRuntimeOptions['chooseWorkspace']): {
  scheduler: Scheduler;
  invokeTurn: ReturnType<typeof vi.fn>;
  appendSystemNote: ReturnType<typeof vi.fn>;
  eventBus: EventBus;
} {
  // Empty conversation history is an open-gate idle scenario: free time owns
  // its private continuity session without requiring an external conversation.
  const nowMs = Date.parse('2026-06-11T15:00:00.000Z');
  const entries: SessionEntry[] = [];
  const appendSystemNote = vi.fn();
  const sessionManager: FreeTimeSessionManagerPort = {
    listRecentlyActiveChannels: () => [],
    getRecentMessages: () => entries,
    getRecentSessionEntries: () => entries,
    appendSystemNote,
    appendContextSystemNote: vi.fn(),
  };

  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
  const invokeTurn = vi.fn(async () => ({ content: REFLECTION_SILENT_TOKEN }));

  let workspaceChannelId = freeTimeWorkspaceChannelId();
  const runtime: FreeTimeRuntimeOptions = {
    scheduler,
    sessionManager,
    config: freeTimeConfig(),
    restWindow,
    eventBus,
    runBlock: ({ run }) => run(() => 0),
    invokeTurn,
    now: () => nowMs,
    resolveWorkspaceChannelId: () => workspaceChannelId,
    ...(chooseWorkspace ? {
      chooseWorkspace: async input => {
        const outcome = await chooseWorkspace(input);
        if (outcome.kind === 'workspace') workspaceChannelId = outcome.workspace.sessionId;
        return outcome;
      },
    } : {}),
  };
  registerFreeTimeTasks(runtime);
  return { scheduler, invokeTurn, appendSystemNote, eventBus };
}

async function runIdleHandler(scheduler: Scheduler): Promise<void> {
  const handler = scheduler.getTask(FREE_TIME_IDLE_TASK_ID)?.handler;
  if (!handler) throw new Error('idle free-time task was not registered');
  await handler({ signal: new AbortController().signal });
}

describe('free-time chooser wiring', () => {
  it('rest ends the block with no free-time turn and a rested block event', async () => {
    const endReasons: string[] = [];
    const chooseWorkspace = vi.fn(async (): Promise<FreeTimeChooserOutcome> => ({
      kind: 'rest',
      reason: 'companion_rested',
    }));
    const { scheduler, invokeTurn, eventBus } = buildRuntime(chooseWorkspace);
    eventBus.on(FREE_TIME_BLOCK_EVENT, (payload: { endReason: string }) => endReasons.push(payload.endReason));

    await runIdleHandler(scheduler);

    expect(chooseWorkspace).toHaveBeenCalledTimes(1);
    // Rest ends the block: the chooser call is the only spend, no free-time turn.
    expect(invokeTurn).not.toHaveBeenCalled();
    expect(endReasons).toEqual(['rested']);
  });

  it('suppressed silence emits a rest_suppressed event without a turn or channel note', async () => {
    const endReasons: string[] = [];
    const chooseWorkspace = vi.fn(async (): Promise<FreeTimeChooserOutcome> => ({
      kind: 'suppressed',
      reason: 'rest_silenced',
    }));
    const { scheduler, invokeTurn, appendSystemNote, eventBus } = buildRuntime(chooseWorkspace);
    eventBus.on(FREE_TIME_BLOCK_EVENT, (payload: { endReason: string }) => endReasons.push(payload.endReason));

    await runIdleHandler(scheduler);

    expect(invokeTurn).not.toHaveBeenCalled();
    expect(appendSystemNote).not.toHaveBeenCalled();
    expect(endReasons).toEqual(['rest_suppressed']);
  });

  it('a chosen workspace runs the block through the ordinary turn path', async () => {
    const chooseWorkspace = vi.fn(async (): Promise<FreeTimeChooserOutcome> => PRIVATE_WORKSPACE_OUTCOME);
    const { scheduler, invokeTurn } = buildRuntime(chooseWorkspace);

    await runIdleHandler(scheduler);

    expect(chooseWorkspace).toHaveBeenCalledTimes(1);
    // A workspace choice proceeds on its own private continuity channel.
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(invokeTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: PRIVATE_WORKSPACE_OUTCOME.workspace.sessionId,
    }));
    expect(PRIVATE_WORKSPACE_OUTCOME.workspace.sessionId).toBe('internal:free-time:private');
  });

  it('without a chooser wired, the block uses its default private session', async () => {
    const { scheduler, invokeTurn } = buildRuntime(undefined);
    await runIdleHandler(scheduler);
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(invokeTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: freeTimeWorkspaceChannelId(),
    }));
  });
});
