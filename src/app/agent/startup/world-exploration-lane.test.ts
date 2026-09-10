import { describe, expect, it, vi } from 'vitest';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import { REFLECTION_SILENT_TOKEN } from '../../../core/scheduler/reflection-policy.js';
import {
  WORLD_EXPLORATION_CHANNEL_ID,
  WORLD_EXPLORATION_TASK_ID,
  registerWorldExplorationLane,
  type WorldExplorationLaneDeps,
} from './world-exploration-lane.js';

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'home', displayName: 'Home', kind: 'physical' },
    { siteId: 'eidoverse', displayName: 'Eidoverse', kind: 'virtual' },
  ],
  places: [
    { placeId: 'office', siteId: 'home', displayName: 'Office', kind: 'physical', affordances: [] },
    { placeId: 'eidoverse:commons', siteId: 'eidoverse', displayName: 'Commons', kind: 'virtual', eidoverse: { world: 'commons' }, affordances: [] },
  ],
};

function makeDeps(overrides: Partial<WorldExplorationLaneDeps> = {}) {
  const registered: Array<{ id: string; intervalMs: number }> = [];
  const handleMessage = vi.fn(async () => ({ content: 'I looked around and waved at the visitor.' }));
  const avatarPerceive = vi.fn(async () => ({
    world: 'commons', capturedAt: 'now', self: null, people: [{ id: 'visitor', positionKnown: false }], things: [], recent: [], raw: '',
  }));
  const deps: WorldExplorationLaneDeps = {
    scheduler: { register: vi.fn((task: { id: string; intervalMs: number }) => { registered.push({ id: task.id, intervalMs: task.intervalMs }); }) } as never,
    config: { enabled: true, intervalMinutes: 30, maxTurnsPerDay: 2 },
    quietHours: null,
    agentLoop: { handleMessage: handleMessage as never },
    placesRegistry: REGISTRY,
    worldOps: { avatarPerceive: avatarPerceive as never },
    capabilityRuntime: { has: () => true },
    eventBus: {} as never,
    chargePolicy: undefined,
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, registered, handleMessage, avatarPerceive };
}

describe('world exploration lane (07mw2)', () => {
  it('registers one gate-check task and invites a turn only when every gate holds', async () => {
    const { deps, registered, handleMessage, avatarPerceive } = makeDeps();
    const lane = registerWorldExplorationLane(deps);
    expect(registered).toEqual([{ id: WORLD_EXPLORATION_TASK_ID, intervalMs: 5 * 60_000 }]);

    await expect(lane.runOnce()).resolves.toBe('invited');
    // The body says where it is; the tracker (which world turns never mark) is not asked.
    expect(avatarPerceive).toHaveBeenCalledWith({});
    const [message] = handleMessage.mock.calls[0] as unknown as [{ channelId: string; content: string; authorId: string }];
    expect(message.channelId).toBe(WORLD_EXPLORATION_CHANNEL_ID);
    expect(message.authorId).toBe('scheduler');
    expect(message.content).toContain('You have a body in the world "commons" right now, standing at Commons');
    expect(message.content).toContain('1 other');
    expect(message.content).toContain(REFLECTION_SILENT_TOKEN);
  });

  it('resolves the place the Hub names, and refuses a named place bound to a different world', async () => {
    const named = makeDeps({
      placesRegistry: {
        ...REGISTRY,
        places: [
          ...REGISTRY.places,
          { placeId: 'eidoverse:atrium', siteId: 'eidoverse', displayName: 'Atrium', kind: 'virtual', eidoverse: { world: 'commons' }, affordances: [] },
        ],
      },
      worldOps: { avatarPerceive: vi.fn(async () => ({ world: 'commons', placeId: 'eidoverse:atrium', capturedAt: 'now', self: null, people: [], things: [], recent: [], raw: '' })) as never },
    });
    await expect(registerWorldExplorationLane(named.deps).runOnce()).resolves.toBe('invited');
    const [message] = named.handleMessage.mock.calls[0] as unknown as [{ content: string }];
    expect(message.content).toContain('standing at Atrium');

    const mismatched = makeDeps({
      worldOps: { avatarPerceive: vi.fn(async () => ({ world: 'garden', placeId: 'eidoverse:commons', capturedAt: 'now', self: null, people: [], things: [], recent: [], raw: '' })) as never },
    });
    await expect(registerWorldExplorationLane(mismatched.deps).runOnce()).resolves.toBe('not_on_world_plane');
  });

  it('skips when disabled, below tier, when the map does not know the world, or when the Hub has no live body', async () => {
    const disabled = makeDeps({ config: { enabled: false, intervalMinutes: 30, maxTurnsPerDay: 2 } });
    await expect(registerWorldExplorationLane(disabled.deps).runOnce()).resolves.toBe('disabled');

    const nursery = makeDeps({ capabilityRuntime: { has: () => false } });
    await expect(registerWorldExplorationLane(nursery.deps).runOnce()).resolves.toBe('tier');

    // The registry has no place for the world the body stands in.
    const unmapped = makeDeps({ placesRegistry: { ...REGISTRY, places: REGISTRY.places.filter((place) => place.placeId === 'office') } });
    await expect(registerWorldExplorationLane(unmapped.deps).runOnce()).resolves.toBe('not_on_world_plane');
    expect(unmapped.handleMessage).not.toHaveBeenCalled();

    const offline = makeDeps({ worldOps: { avatarPerceive: vi.fn(async () => { throw new Error('hub offline'); }) as never } });
    await expect(registerWorldExplorationLane(offline.deps).runOnce()).resolves.toBe('no_body');
    expect(offline.handleMessage).not.toHaveBeenCalled();

    const elsewhere = makeDeps({
      worldOps: { avatarPerceive: vi.fn(async () => ({ world: 'garden', capturedAt: 'now', self: null, people: [], things: [], recent: [], raw: '' })) as never },
    });
    await expect(registerWorldExplorationLane(elsewhere.deps).runOnce()).resolves.toBe('not_on_world_plane');

    const unwired = makeDeps({ worldOps: {} });
    await expect(registerWorldExplorationLane(unwired.deps).runOnce()).resolves.toBe('no_body');
  });

  it('honours quiet hours, the interval, the daily cap, and treats the silent token as a quiet answer', async () => {
    const quiet = makeDeps({
      quietHours: { enabled: true, startLocalTime: '00:00', endLocalTime: '23:59', timeZone: 'UTC' },
    });
    await expect(registerWorldExplorationLane(quiet.deps).runOnce()).resolves.toBe('quiet_hours');

    let nowMs = 1_000_000;
    const paced = makeDeps({
      now: () => nowMs,
      agentLoop: {
        handleMessage: vi.fn(async () => ({ content: `  ${REFLECTION_SILENT_TOKEN}  ` })) as never,
      },
    });
    const lane = registerWorldExplorationLane(paced.deps);
    await expect(lane.runOnce()).resolves.toBe('silent');
    await expect(lane.runOnce()).resolves.toBe('interval');
    nowMs += 31 * 60_000;
    await expect(lane.runOnce()).resolves.toBe('silent');
    nowMs += 31 * 60_000;
    await expect(lane.runOnce()).resolves.toBe('daily_cap');
    // A new day resets the cap.
    nowMs += 24 * 60 * 60_000;
    await expect(lane.runOnce()).resolves.toBe('silent');
  });
});
