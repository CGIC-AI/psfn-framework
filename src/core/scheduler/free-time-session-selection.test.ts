import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import { EventBus } from '../../shared/event-bus.js';
import { DEFAULT_FREE_TIME_CONFIG } from '../../system/config/scheduler-config.js';
import { Scheduler } from './scheduler.js';
import {
  FREE_TIME_IDLE_TASK_ID,
  FREE_TIME_QUIET_HOURS_TASK_ID,
  registerFreeTimeTasks,
} from './free-time.js';

const NOW = Date.parse('2026-06-11T06:00:00Z');
let directory: string;
let store: SessionStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'free-time-session-selection-'));
  store = new SessionStore(directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function append(channelId: string, timestamp: number): void {
  store.append({ channelId, timestamp, role: 'user', content: 'Fixture conversation.' });
}

async function runLane(taskId: string) {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
  const chooseWorkspace = vi.fn(async () => ({ kind: 'rest' as const, reason: 'companion_rested' as const }));
  const invokeTurn = vi.fn(async () => ({ content: 'unused' }));
  const getRecentMessages = vi.fn((sessionId: string, limit?: number) => store.getRecent(sessionId, limit));
  const sessionManager = {
    resolveStartupSessionMetadata: () => store.getLatestSessionByTimestamp(),
    listRecentSessions: (limit?: number) => store.listSessionsByRecentActivity(limit),
    getRecentMessages,
    appendSystemNote: vi.fn(),
    appendContextSystemNote: vi.fn(),
  };
  registerFreeTimeTasks({
    scheduler,
    sessionManager,
    config: {
      ...DEFAULT_FREE_TIME_CONFIG,
      enabled: true,
      quietHours: { enabled: true, checkIntervalMs: 1_000 },
      idle: { enabled: true, checkIntervalMs: 1_000, minIdleMinutes: 180 },
    },
    restWindow: {
      enabled: true, startLocalTime: '00:00', endLocalTime: '09:00',
      timeZone: 'UTC', inactivityThresholdMinutes: 180,
    },
    eventBus,
    runBlock: ({ run }) => run(() => 0),
    chooseWorkspace,
    invokeTurn,
    now: () => NOW,
  });
  const handler = scheduler.getTask(taskId)?.handler;
  if (!handler) throw new Error('Free-time task was not registered');
  await handler();
  return { chooseWorkspace, invokeTurn, getRecentMessages };
}

describe('free-time opportunity session selection', () => {
  it.each([FREE_TIME_IDLE_TASK_ID, FREE_TIME_QUIET_HOURS_TASK_ID])(
    '%s still offers a choice after newer internal work without a new partner message', async taskId => {
      append('api:partner', NOW - 8 * 60 * 60_000);
      append('internal:reflection:daily', NOW - 60_000);
      append('internal:free-time:private', NOW - 30_000);
      const result = await runLane(taskId);
      expect(result.chooseWorkspace).toHaveBeenCalledOnce();
      expect(result.getRecentMessages).toHaveBeenCalledWith('api:partner', 16);
      expect(result.invokeTurn).not.toHaveBeenCalled();
    },
  );

  it('preserves the recent partner guard despite a newer internal session', async () => {
    append('api:partner', NOW - 30 * 60_000);
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).not.toHaveBeenCalled();
  });

  it('does not skip an external public session to use an older private session', async () => {
    append('api:partner', NOW - 10 * 60 * 60_000);
    append('twitter:timeline', NOW - 8 * 60 * 60_000);
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).not.toHaveBeenCalled();
  });

  it('does not invent a conversational session when only internal work exists', async () => {
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).not.toHaveBeenCalled();
  });
});
