import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { BackgroundMaintenanceRegistry } from '../scheduler/background-maintenance.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { groomConcernSet, registerConcernGroomingOperation } from './concern-grooming.js';

function makeStore() {
  let counter = 0;
  return createTestPostgresIntentionPorts({
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    idFactory: () => `concern-${++counter}`,
  }).ports.concernStore;
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

  it('registers concern grooming on the shared background-maintenance task', async () => {
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

    const backgroundMaintenance = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate: createEligibilityGate(() => ({
        getTier: () => 'autonomous',
        getGrantedTokens: () => new Set(),
        has: () => true,
      })),
      intervalMs: 3_600_000,
    });
    registerConcernGroomingOperation({
      backgroundMaintenance,
      concernStore,
      eventBus,
      maxActiveConcerns: 7,
    });

    const task = scheduler.getTask('background-maintenance');
    expect(task).toMatchObject({
      name: 'Bundled Background Maintenance',
      type: 'every',
      operations: [{ id: 'concern-grooming', name: 'Concern Grooming' }],
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
