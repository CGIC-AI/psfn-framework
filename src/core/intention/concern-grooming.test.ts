import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { createConcernStorePort } from './concern-store-port.js';
import { ActiveConcernStore } from './concerns.js';
import { groomConcernSet, registerConcernGroomingTask } from './concern-grooming.js';

function makeStore() {
  const db = new Database(':memory:');
  let counter = 0;
  return createConcernStorePort(new ActiveConcernStore(db, {
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    idFactory: () => `concern-${++counter}`,
  }));
}

const activeGroomingTexts = [
  'Cardiology appointment logistics',
  'Database migration rollback checklist',
  'Voice latency regression follow up',
  'Hydration routine check after medication change',
  'Backup verification audit evidence',
];

describe('concern grooming', () => {
  it('resolves stale concerns and trims active overflow as maintenance', async () => {
    const concernStore = makeStore();
    for (const [i, text] of activeGroomingTexts.entries()) {
      await concernStore.create({
        text,
        priority: i === 0 ? 'high' : 'low',
        expiresAt: `2026-06-30T1${i}:00:00.000Z`,
      });
    }
    await concernStore.create({
      text: 'Expired appointment thread',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });

    const result = await groomConcernSet({
      concernStore,
      asOf: '2026-06-29T12:00:00.000Z',
      maxActiveConcerns: 3,
    });

    expect(result.staleResolved.map(concern => concern.text)).toEqual([
      'Expired appointment thread',
    ]);
    expect(result.capResolved).toHaveLength(2);
    expect(result.activeCountBeforeCap).toBe(5);
    expect(result.activeCountAfterCap).toBe(3);
    expect(await concernStore.getActiveConcerns()).toHaveLength(3);
  });

  it('registers a daily concern grooming scheduler task', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 });
    const concernStore = makeStore();
    const events: unknown[] = [];
    eventBus.on('intention.concern.groomed', event => {
      events.push(event);
    });
    await concernStore.create({
      text: 'Soon-expired concern',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });

    registerConcernGroomingTask({
      scheduler,
      concernStore,
      eventBus,
      intervalMs: 1,
    });

    const task = scheduler.getTask('concern-grooming');
    expect(task).toMatchObject({
      name: 'Concern Grooming',
      type: 'every',
      cadence: { kind: 'daily', hour: 6, minute: 15, timezone: 'local' },
    });
    expect(task?.handler).toBeDefined();
    await task?.handler();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      staleResolvedCount: 1,
      capResolvedCount: 0,
    });
  });
});
