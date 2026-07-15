import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import {
  BACKGROUND_MAINTENANCE_TASK_ID,
  BackgroundMaintenanceRegistry,
} from './background-maintenance.js';
import { Scheduler } from './scheduler.js';
import { evaluateRestWindowEligibility } from './rest-window.js';
import {
  resetActiveTimezone,
  setActiveTimezone,
} from '../../shared/time/active-timezone.js';

const ORIGINAL_TZ = process.env.TZ;

function localDateKey(nowMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(nowMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

describe('BackgroundMaintenanceRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetActiveTimezone();
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it('registers one honest task manifest and isolates eligibility and failures per operation', async () => {
    const eventBus = new EventBus();
    const granted = new Set<CapabilityToken>(['memory.write']);
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => granted,
      has: token => granted.has(token),
    }));
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 100,
      heartbeatIntervalMs: 500,
    });
    const registry = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });
    const allowed = vi.fn();
    const denied = vi.fn();
    const failing = vi.fn().mockRejectedValue(new Error('expected failure'));
    const trailing = vi.fn();

    registry.registerOperation({
      id: 'memory.salience-decay',
      name: 'Memory Salience Decay',
      description: 'Apply salience decay to durable memories.',
      eligibility: { requiredTokens: ['memory.write'] },
      handler: allowed,
    });
    registry.registerOperation({
      id: 'contacts.trust-drift-review.rest-window',
      name: 'Contact Trust-Drift Rest-Window Check',
      description: 'Check whether the contact review lane is eligible.',
      eligibility: { requiredTokens: ['identity.read'] },
      handler: denied,
    });
    registry.registerOperation({
      id: 'failure',
      name: 'Failure Probe',
      description: 'Prove that operation failures are isolated.',
      handler: failing,
    });
    registry.registerOperation({
      id: 'trailing',
      name: 'Trailing Probe',
      description: 'Must run after a prior operation fails.',
      handler: trailing,
    });

    expect(scheduler.listTasks()).toHaveLength(1);
    expect(scheduler.getTask(BACKGROUND_MAINTENANCE_TASK_ID)).toMatchObject({
      id: BACKGROUND_MAINTENANCE_TASK_ID,
      name: 'Bundled Background Maintenance',
      intervalMs: 3_600_000,
      scheduleSource: 'scheduler.json > backgroundMaintenance.intervalMs',
      operations: [
        { id: 'memory.salience-decay', name: 'Memory Salience Decay' },
        {
          id: 'contacts.trust-drift-review.rest-window',
          name: 'Contact Trust-Drift Rest-Window Check',
        },
        { id: 'failure', name: 'Failure Probe' },
        { id: 'trailing', name: 'Trailing Probe' },
      ],
    });

    const task = scheduler.getTask(BACKGROUND_MAINTENANCE_TASK_ID);
    await expect(task?.handler()).rejects.toThrow('1 of 4 background-maintenance operations failed');
    expect(allowed).toHaveBeenCalledOnce();
    expect(denied).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledOnce();
    expect(trailing).toHaveBeenCalledOnce();
  });

  it('rejects duplicate operation ids', () => {
    const eventBus = new EventBus();
    const scheduler = new Scheduler(eventBus);
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(),
      has: () => true,
    }));
    const registry = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });
    const operation = {
      id: 'duplicate',
      name: 'Duplicate',
      description: 'Duplicate test operation.',
      handler: () => {},
    };

    registry.registerOperation(operation);
    expect(() => registry.registerOperation(operation)).toThrow(
      'Background-maintenance operation "duplicate" is already registered',
    );
  });

  it.each([
    {
      label: 'UTC',
      configuredTimeZone: 'UTC',
      resolvedTimeZone: 'UTC',
      startMs: Date.parse('2026-03-05T07:30:00.000Z'),
      expectedWindowDays: ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'],
    },
    {
      label: 'settings-owned local time across the DST transition',
      configuredTimeZone: 'local',
      resolvedTimeZone: 'America/New_York',
      startMs: Date.parse('2026-03-07T12:30:00.000Z'),
      expectedWindowDays: ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
    },
  ])('hits every cross-midnight rest window from an adversarial closing-boundary phase in $label', async ({
    configuredTimeZone,
    resolvedTimeZone,
    startMs,
    expectedWindowDays,
  }) => {
    setActiveTimezone('America/New_York');
    let nowMs = startMs;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const eventBus = new EventBus();
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(),
      has: () => true,
    }));
    const scheduler = new Scheduler(eventBus, {
      tickIntervalMs: 60_000,
      heartbeatIntervalMs: 90_000,
    });
    const registry = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });
    const eligibleWindowDays = new Set<string>();
    registry.registerOperation({
      id: 'rest-window-probe',
      name: 'Rest Window Probe',
      description: 'Records each rest window reached by the relative bundled cadence.',
      handler: () => {
        const decision = evaluateRestWindowEligibility({
          config: {
            enabled: true,
            startLocalTime: '23:00',
            endLocalTime: '07:30',
            timeZone: configuredTimeZone,
            inactivityThresholdMinutes: 1,
          },
          nowMs,
        });
        if (decision.allowed) {
          // Shifting a midnight-crossing instant back 12 hours maps both sides
          // of this window to the local date on which that window opened.
          eligibleWindowDays.add(localDateKey(nowMs - 12 * 3_600_000, resolvedTimeZone));
        }
      },
    });

    const simulationMinutes = 4 * 24 * 60 + 120;
    for (let minute = 0; minute < simulationMinutes; minute += 1) {
      nowMs += 60_000;
      await scheduler.tick();
    }

    expect([...eligibleWindowDays]).toEqual(expect.arrayContaining(expectedWindowDays));
  });
});
