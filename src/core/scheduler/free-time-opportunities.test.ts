import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { SessionManager } from '../session/manager.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { EventBus } from '../../shared/event-bus.js';
import { DEFAULT_FREE_TIME_CONFIG } from '../../system/config/scheduler-config.js';
import { Scheduler } from './scheduler.js';
import { REFLECTION_SILENT_TOKEN } from './reflection-policy.js';
import type { FreeTimeChooserOutcome } from './free-time-chooser.js';
import { resolveFreeTimeWorkspace } from './free-time-workspace-resolver.js';
import {
  FREE_TIME_IDLE_TASK_ID,
  FREE_TIME_QUIET_HOURS_TASK_ID,
  registerFreeTimeTasks,
  freeTimeWorkspaceChannelId,
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

async function runLane(taskId: string, options: { activity?: boolean; nowMs?: number } = {}) {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 500 });
  const workspace = resolveFreeTimeWorkspace({ kind: 'private_wander' }, {
    projectDirectory: () => null, roomChannelResolver: () => null,
  });
  const chooseWorkspace = vi.fn(async (): Promise<FreeTimeChooserOutcome> => options.activity
    ? { kind: 'workspace', workspace, label: 'Private wandering' }
    : { kind: 'rest', reason: 'companion_rested' });
  const invokeTurn = vi.fn(async (_input: { channelId: string; audience: 'self'; content: string }) => ({ content: REFLECTION_SILENT_TOKEN }));
  const gateEvents: Array<{ sessionId?: string; channelId?: string }> = [];
  eventBus.on('scheduler.free_time.gate', event => { gateEvents.push(event); });
  const getRecentMessages = vi.fn((sessionId: string, limit?: number) => store.getRecent(sessionId, limit));
  const manager = new SessionManager(store, fromPartial<SubstrateConfig>({ dataDir: directory }), eventBus);
  const sessionManager = {
    listRecentlyActiveChannels: manager.listRecentlyActiveChannels.bind(manager),
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
    resolveWorkspaceChannelId: () => workspace.sessionId,
    now: () => options.nowMs ?? NOW,
  });
  const handler = scheduler.getTask(taskId)?.handler;
  if (!handler) throw new Error('Free-time task was not registered');
  await handler();
  return { chooseWorkspace, invokeTurn, getRecentMessages, gateEvents, sessionManager, workspace };
}

describe('private free-time opportunities', () => {
  it.each([FREE_TIME_IDLE_TASK_ID, FREE_TIME_QUIET_HOURS_TASK_ID])(
    '%s still offers a choice after newer internal work without a new partner message', async taskId => {
      append('api:partner', NOW - 8 * 60 * 60_000);
      append('internal:reflection:daily', NOW - 60_000);
      append('internal:free-time:private', NOW - 30_000);
      const result = await runLane(taskId);
      expect(result.chooseWorkspace).toHaveBeenCalledOnce();
      expect(result.getRecentMessages).not.toHaveBeenCalled();
      expect(result.invokeTurn).not.toHaveBeenCalled();
    },
  );

  it('preserves the recent partner guard despite a newer internal session', async () => {
    append('api:partner', NOW - 30 * 60_000);
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).not.toHaveBeenCalled();
  });

  it('allows private free time when the latest external session is public', async () => {
    append('api:partner', NOW - 10 * 60 * 60_000);
    append('twitter:timeline', NOW - 8 * 60 * 60_000);
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).toHaveBeenCalledOnce();
  });

  it('allows private free time when only internal work exists', async () => {
    append('internal:reflection:daily', NOW - 60_000);
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).toHaveBeenCalledOnce();
  });

  it.each([FREE_TIME_IDLE_TASK_ID, FREE_TIME_QUIET_HOURS_TASK_ID])(
    '%s offers a new companion free time without any external history', async taskId => {
      expect((await runLane(taskId)).chooseWorkspace).toHaveBeenCalledOnce();
    },
  );

  it.each([FREE_TIME_IDLE_TASK_ID, FREE_TIME_QUIET_HOURS_TASK_ID])(
    '%s executes a chosen activity only on the private free-time session', async taskId => {
      append('twitter:timeline', NOW - 8 * 60 * 60_000);
      const result = await runLane(taskId, { activity: true });
      expect(result.invokeTurn).toHaveBeenCalledOnce();
      expect(result.invokeTurn.mock.calls[0]?.[0]).toMatchObject({
        channelId: result.workspace.sessionId, audience: 'self',
      });
      expect(JSON.stringify(result.invokeTurn.mock.calls)).not.toContain('Fixture conversation.');
      expect(result.gateEvents).toEqual([expect.objectContaining({
        channelId: freeTimeWorkspaceChannelId(), sessionId: freeTimeWorkspaceChannelId(),
      })]);
      expect(result.sessionManager.appendSystemNote.mock.calls.every(
        call => call[0] === result.workspace.sessionId,
      )).toBe(true);
      expect(result.getRecentMessages).not.toHaveBeenCalled();
    },
  );

  it('ignores recent system notes in an old external conversation', async () => {
    append('api:partner', NOW - 8 * 60 * 60_000);
    store.append({ channelId: 'api:partner', timestamp: NOW - 1, role: 'system', content: 'Operational note.' });
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).toHaveBeenCalledOnce();
  });

  it('keeps the partner guard when a recent partner turn is buried behind system notes', async () => {
    append('api:partner', NOW - 60_000);
    for (let index = 0; index < 64; index += 1) {
      store.append({ channelId: 'api:partner', timestamp: NOW - 1, role: 'system', content: 'Operational note.' });
    }
    expect((await runLane(FREE_TIME_IDLE_TASK_ID)).chooseWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the quiet-hours clock for a new companion', async () => {
    const nowMs = Date.parse('2026-06-11T14:00:00Z');
    expect((await runLane(FREE_TIME_QUIET_HOURS_TASK_ID, { nowMs })).chooseWorkspace).not.toHaveBeenCalled();
    expect((await runLane(FREE_TIME_IDLE_TASK_ID, { nowMs })).chooseWorkspace).toHaveBeenCalledOnce();
  });

});
