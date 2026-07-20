import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import { BackgroundMaintenanceRegistry } from '../scheduler/background-maintenance.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import {
  groomConcernSet,
  registerConcernGroomingOperation,
  resolveCurrentInternalStateConcernVAD,
} from './concern-grooming.js';

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
  it('only uses a fresh emotional snapshot from the concern contact scope', () => {
    const concern = {
      id: 'concern-a',
      contactId: 'contact-a',
    };
    const state = {
      emotional: {
        vad: { valence: 0.3, arousal: -0.2, dominance: 0.1 },
        telemetry: {
          status: 'trusted',
          observedAtMs: Date.parse('2026-06-29T11:55:00.000Z'),
          staleAfterMs: 10 * 60_000,
        },
      },
      relational: { contactId: 'contact-a' },
    };

    expect(resolveCurrentInternalStateConcernVAD(
      concern,
      state,
      '2026-06-29T12:00:00.000Z',
    )).toEqual({ valence: 0.3, arousal: -0.2, dominance: 0.1 });
    expect(resolveCurrentInternalStateConcernVAD(
      { ...concern, contactId: 'contact-b' },
      state,
      '2026-06-29T12:00:00.000Z',
    )).toBeUndefined();
    expect(resolveCurrentInternalStateConcernVAD(
      concern,
      {
        ...state,
        emotional: {
          ...state.emotional,
          telemetry: {
            ...state.emotional.telemetry,
            observedAtMs: Date.parse('2026-06-29T11:40:00.000Z'),
          },
        },
      },
      '2026-06-29T12:00:00.000Z',
    )).toBeUndefined();
  });

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

  it('captures resolutionVAD and emits a resolution appraisal on grooming resolves', async () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 });
    const concernStore = makeStore();
    const appraisals: Array<{
      concernId: string;
      source: string;
      reliefDelta: { valence: number; arousal: number; dominance: number };
    }> = [];
    eventBus.on('intention.concern.resolution_appraisal', event => {
      appraisals.push(event as (typeof appraisals)[number]);
    });

    const stale = await concernStore.create({
      text: 'Stale concern with a formation snapshot',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
      formationVAD: { valence: -0.5, arousal: 0.4, dominance: -0.3 },
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
      resolutionVadProvider: () => ({ valence: 0.2, arousal: 0.1, dominance: 0.0 }),
    });

    await scheduler.getTask('background-maintenance')?.handler();

    // Persistence: the resolved row carries the captured resolution snapshot.
    const reloaded = await concernStore.getById(stale.id);
    expect(reloaded?.status).toBe('resolved');
    expect(reloaded?.resolutionVAD).toEqual({ valence: 0.2, arousal: 0.1, dominance: 0.0 });

    // Emission: a relief-delta appraisal is observed for the grooming resolve.
    expect(appraisals).toHaveLength(1);
    expect(appraisals[0].concernId).toBe(stale.id);
    expect(appraisals[0].source).toBe('grooming_stale');
    expect(appraisals[0].reliefDelta.valence).toBeCloseTo(0.7, 10);
    expect(appraisals[0].reliefDelta.arousal).toBeCloseTo(-0.3, 10);
    expect(appraisals[0].reliefDelta.dominance).toBeCloseTo(0.3, 10);
  });

  it('requests a scoped resolution VAD separately for each retired concern', async () => {
    const concernStore = makeStore();
    const contactA = await concernStore.create({
      text: 'Expired contact A concern',
      contactId: 'contact-a',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });
    const contactB = await concernStore.create({
      text: 'Expired contact B concern',
      contactId: 'contact-b',
      createdAt: '2026-06-28T10:00:00.000Z',
      expiresAt: '2026-06-29T11:00:00.000Z',
    });

    await groomConcernSet({
      concernStore,
      asOf: '2026-06-29T12:00:00.000Z',
      resolutionVadProvider: concern => concern.contactId === 'contact-a'
        ? { valence: 0.4, arousal: 0.1, dominance: 0.2 }
        : undefined,
    });

    expect((await concernStore.getById(contactA.id))?.resolutionVAD).toEqual({
      valence: 0.4,
      arousal: 0.1,
      dominance: 0.2,
    });
    expect((await concernStore.getById(contactB.id))?.resolutionVAD).toBeUndefined();
  });
});
