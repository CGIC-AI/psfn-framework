import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import {
  BACKGROUND_MAINTENANCE_TASK_ID,
  BackgroundMaintenanceRegistry,
} from './background-maintenance.js';
import { Scheduler } from './scheduler.js';

describe('BackgroundMaintenanceRegistry', () => {
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
});
