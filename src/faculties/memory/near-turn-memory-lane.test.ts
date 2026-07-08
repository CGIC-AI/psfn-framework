import { describe, it, expect, vi } from 'vitest';
import type { NearTurnMemoryCadenceConfig } from '../../system/config/scheduler-config.js';
import {
  NearTurnMemoryLane,
  NEAR_TURN_MEMORY_ACTION_KIND,
  type NearTurnMemoryCadenceTelemetry,
} from './near-turn-memory-lane.js';

function cadence(overrides: {
  directCadenceTurns?: number;
  groupMinIntervalMinutes?: number;
  groupMinNewEntries?: number;
} = {}): NearTurnMemoryCadenceConfig {
  return {
    direct: { cadenceTurns: overrides.directCadenceTurns ?? 3 },
    group: {
      minIntervalMinutes: overrides.groupMinIntervalMinutes ?? 15,
      minNewEntries: overrides.groupMinNewEntries ?? 8,
    },
  };
}

function makeSessionManager() {
  return {
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
  };
}

function makeScopeClassifier(scope: 'direct' | 'group') {
  // Stands in for ObservedGroupMemoryScheduler.classifyChannelMemoryScope —
  // the canonical memoryMode/topology classifier shared with group extraction.
  return {
    classifyChannelMemoryScope: vi.fn(async () => scope),
  };
}

function makeLane(options: {
  cadence: NearTurnMemoryCadenceConfig;
  scope?: 'direct' | 'group';
  onCadenceTelemetry?: (event: NearTurnMemoryCadenceTelemetry) => void;
  memoryMaintenanceStore?: {
    listActiveMemories: ReturnType<typeof vi.fn>;
    upsertMemoryMaintenanceReview: ReturnType<typeof vi.fn>;
  };
}): NearTurnMemoryLane {
  return new NearTurnMemoryLane({
    sessionManager: makeSessionManager(),
    cadence: options.cadence,
    ...(options.scope ? { scopeClassifier: makeScopeClassifier(options.scope) } : {}),
    ...(options.onCadenceTelemetry ? { onCadenceTelemetry: options.onCadenceTelemetry } : {}),
    ...(options.memoryMaintenanceStore ? { memoryMaintenanceStore: options.memoryMaintenanceStore } : {}),
  });
}

describe('NearTurnMemoryLane', () => {
  it('fails closed on invalid cadence config instead of silently defaulting', () => {
    expect(() => makeLane({
      cadence: cadence({ directCadenceTurns: 0 }),
    })).toThrow('cadence.direct.cadenceTurns must be an integer >= 1');
    expect(() => makeLane({
      cadence: cadence({ groupMinNewEntries: -1 }),
    })).toThrow('cadence.group.minNewEntries must be an integer >= 1');
  });

  it('triggers near-turn actions on configured direct cadence for external sessions', async () => {
    const lane = makeLane({ cadence: cadence({ directCadenceTurns: 3 }) });

    expect(await lane.inferPostTurnAction({ id: 'm1', channelId: 'terminal:alpha' })).toBeNull();
    expect(await lane.inferPostTurnAction({ id: 'm2', channelId: 'terminal:alpha' })).toBeNull();
    const third = await lane.inferPostTurnAction({ id: 'm3', channelId: 'terminal:alpha' });
    expect(third).toMatchObject({
      kind: NEAR_TURN_MEMORY_ACTION_KIND,
      dedupeKey: `${NEAR_TURN_MEMORY_ACTION_KIND}:terminal:alpha`,
      payload: {
        sessionId: 'terminal:alpha',
        cadenceTurn: 3,
      },
    });
    expect(await lane.inferPostTurnAction({ id: 'm4', channelId: 'internal:reflection:whisper' })).toBeNull();
  });

  it('batches group rooms by interval + watermark instead of per-N-turns', async () => {
    const lane = makeLane({
      cadence: cadence({ groupMinIntervalMinutes: 30, groupMinNewEntries: 8 }),
      scope: 'group',
    });

    const baseMs = Date.parse('2026-06-01T12:00:00.000Z');
    let fired = 0;
    for (let turn = 1; turn <= 30; turn += 1) {
      const action = await lane.inferPostTurnAction({
        id: `g${turn}`,
        channelId: 'discord:room-1',
        channelType: 'discord',
        timestamp: new Date(baseMs + turn * 1_000),
      });
      if (action) fired += 1;
    }

    expect(fired).toBeLessThanOrEqual(2);
    expect(fired).toBeGreaterThanOrEqual(1);
  });

  it('fires additional group runs once the interval genuinely elapses', async () => {
    const lane = makeLane({
      cadence: cadence({ groupMinIntervalMinutes: 30, groupMinNewEntries: 4 }),
      scope: 'group',
    });
    const baseMs = Date.parse('2026-06-01T12:00:00.000Z');
    const channelId = 'discord:room-2';

    const fireCounts: number[] = [];
    for (let burst = 0; burst < 2; burst += 1) {
      let fired = 0;
      for (let turn = 1; turn <= 4; turn += 1) {
        const action = await lane.inferPostTurnAction({
          id: `b${burst}-${turn}`,
          channelId,
          channelType: 'discord',
          timestamp: new Date(baseMs + burst * 31 * 60_000 + turn * 1_000),
        });
        if (action) fired += 1;
      }
      fireCounts.push(fired);
    }

    expect(fireCounts).toEqual([1, 1]);
  });

  it('treats sessions without a scope classifier as direct scope (historical posture)', async () => {
    const lane = makeLane({ cadence: cadence({ directCadenceTurns: 3 }) });
    expect(await lane.inferPostTurnAction({ id: 'u1', channelId: 'terminal:x' })).toBeNull();
    expect(await lane.inferPostTurnAction({ id: 'u2', channelId: 'terminal:x' })).toBeNull();
    expect(await lane.inferPostTurnAction({ id: 'u3', channelId: 'terminal:x' })).not.toBeNull();
  });

  it('degrades to group batching when scope classification fails (logged, compute-conservative)', async () => {
    const failingClassifier = {
      classifyChannelMemoryScope: vi.fn(async () => {
        throw new Error('classifier unavailable');
      }),
    };
    const lane = new NearTurnMemoryLane({
      sessionManager: makeSessionManager(),
      cadence: cadence({ directCadenceTurns: 1, groupMinIntervalMinutes: 30, groupMinNewEntries: 8 }),
      scopeClassifier: failingClassifier,
    });

    const baseMs = Date.parse('2026-06-01T12:00:00.000Z');
    let fired = 0;
    for (let turn = 1; turn <= 6; turn += 1) {
      const action = await lane.inferPostTurnAction({
        id: `f${turn}`,
        channelId: 'discord:room-err',
        channelType: 'discord',
        timestamp: new Date(baseMs + turn * 1_000),
      });
      if (action) fired += 1;
    }

    expect(fired).toBe(0);
    expect(failingClassifier.classifyChannelMemoryScope).toHaveBeenCalled();
  });

  it('emits fire-rate cadence telemetry per channel', async () => {
    const events: NearTurnMemoryCadenceTelemetry[] = [];
    const lane = makeLane({
      cadence: cadence({ directCadenceTurns: 1 }),
      scope: 'direct',
      onCadenceTelemetry: (event) => { events.push(event); },
    });
    const baseMs = Date.parse('2026-06-01T12:00:00.000Z');

    for (let turn = 1; turn <= 3; turn += 1) {
      await lane.inferPostTurnAction({
        id: `t${turn}`,
        channelId: 'discord:dm-9',
        channelType: 'discord',
        timestamp: new Date(baseMs + turn * 1_000),
      });
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      channelId: 'discord:dm-9',
      scope: 'direct',
      turnCount: 1,
      firesLastHour: 1,
    });
    expect(events[2]).toMatchObject({ firesLastHour: 3, scope: 'direct' });
  });

  it('performs only deterministic active-memory review refresh on execute (no LLM surface exists)', async () => {
    const staleMemory = {
      id: 'memory-stale-1',
      text: 'Old fact that has not been touched in a long time.',
      type: 'semantic',
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      tags: [],
      sensitivity: 'personal',
      createdAt: Date.now() - 200 * 24 * 60 * 60_000,
      updatedAt: Date.now() - 200 * 24 * 60 * 60_000,
      lastAccessedAt: Date.now() - 200 * 24 * 60 * 60_000,
      accessCount: 1,
      salience: 0.4,
      sourceRef: 'source:test',
    };
    const memoryMaintenanceStore = {
      listActiveMemories: vi.fn().mockResolvedValue([staleMemory]),
      upsertMemoryMaintenanceReview: vi.fn(async (input: { id?: string }) => ({ id: input.id ?? 'review-1' })),
    };
    const lane = makeLane({
      cadence: cadence({ directCadenceTurns: 1 }),
      memoryMaintenanceStore,
    });

    // Structural guarantee: the lane exposes no LLM provider surface at all.
    expect(Object.keys(lane as unknown as Record<string, unknown>)).not.toContain('llmProvider');

    await lane.execute({
      id: 'near-turn-action-1',
      channelId: 'terminal:test',
      payload: { sessionId: 'terminal:test' },
    });

    expect(memoryMaintenanceStore.listActiveMemories).toHaveBeenCalledWith({ limit: 50 });
  });
});
