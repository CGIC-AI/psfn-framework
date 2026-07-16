import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { BackgroundMaintenanceRegistry } from '../../core/scheduler/background-maintenance.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
  SHARED_WORLD_WIKI_CARETAKER_OPERATION_ID,
  registerBackgroundWorkSupervisorTask,
  registerSharedWorldWikiCaretakerOperation,
  registerSalienceDecayOperation,
} from './scheduler-runtime.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('agent scheduler runtime wiring', () => {
  it('registers ambient presence on the shared background-maintenance task', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('registerAmbientPresenceOperation({');
    expect(source).toContain('backgroundMaintenance,');
    expect(source).toContain('restWindow: options.schedulerConfig.episodicProcessing');
  });

  it('registers the durable background supervisor on the existing scheduler', async () => {
    const scheduler = new Scheduler(new EventBus());
    const tickBackgroundWork = vi.fn(async () => undefined);
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    registerBackgroundWorkSupervisorTask({
      scheduler,
      agentLoop: {
        hasDurableBackgroundWorkSupervisor: () => true,
        tickBackgroundWork,
      },
      intervalMs: 25,
    });

    expect(BACKGROUND_WORK_SUPERVISOR_TASK_ID).toBe('background-work-supervisor');
    expect(scheduler.getTask(BACKGROUND_WORK_SUPERVISOR_TASK_ID)).toMatchObject({
      intervalMs: 25,
      state: 'idle',
    });
    await scheduler.tick();
    expect(tickBackgroundWork).toHaveBeenCalledOnce();
    expect(source).not.toContain('setInterval(() => options.agentLoop.tickBackgroundWork()');
  });

  it('rejects scheduler registration when durable background ownership is missing', () => {
    expect(() => registerBackgroundWorkSupervisorTask({
      scheduler: new Scheduler(new EventBus()),
      agentLoop: {
        hasDurableBackgroundWorkSupervisor: () => false,
        tickBackgroundWork: async () => undefined,
      },
      intervalMs: 25,
    })).toThrow('Agent scheduler requires a durable background work supervisor');
  });

  it('registers salience decay as an operation on the shared scheduler-owned cadence', () => {
    const scheduler = new Scheduler(new EventBus());
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(),
      has: () => true,
    }));
    const backgroundMaintenance = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    registerSalienceDecayOperation({
      backgroundMaintenance,
      memoryStore: {} as MemoryStorePort,
    });

    expect(scheduler.getTask('background-maintenance')).toMatchObject({
      intervalMs: 3_600_000,
      operations: [{ id: 'salience-decay', name: 'Memory Salience Decay' }],
    });
    expect(source).toContain('intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs');
    expect(source).not.toContain('options.config.salienceDecayIntervalMs');
    expect(source).not.toContain('intervalMs: options.config.maintenanceIntervalMs');
  });

  it('runs bounded shared-world caretaker cleanup on the scheduler-owned maintenance lane', async () => {
    const scheduler = new Scheduler(new EventBus());
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(),
      has: () => true,
    }));
    const backgroundMaintenance = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });
    const cleanupChangedContent = vi.fn(async () => ({
      checked: 2,
      reprojected: 1,
      failed: 0,
    }));

    registerSharedWorldWikiCaretakerOperation({
      backgroundMaintenance,
      caretaker: { cleanupChangedContent },
      batchSize: 25,
    });

    expect(scheduler.getTask('background-maintenance')).toMatchObject({
      operations: [{
        id: SHARED_WORLD_WIKI_CARETAKER_OPERATION_ID,
        name: 'Shared-World Wiki Caretaker',
      }],
    });
    await scheduler.getTask('background-maintenance')?.handler();
    expect(cleanupChangedContent).toHaveBeenCalledOnce();
    expect(cleanupChangedContent).toHaveBeenCalledWith(25);
  });

  it('surfaces failed caretaker projections through the maintenance task failure boundary', async () => {
    const scheduler = new Scheduler(new EventBus());
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(),
      has: () => true,
    }));
    const backgroundMaintenance = new BackgroundMaintenanceRegistry({
      scheduler,
      eligibilityGate,
      intervalMs: 3_600_000,
    });

    registerSharedWorldWikiCaretakerOperation({
      backgroundMaintenance,
      caretaker: {
        cleanupChangedContent: async () => ({ checked: 1, reprojected: 0, failed: 1 }),
      },
      batchSize: 25,
    });

    await expect(scheduler.getTask('background-maintenance')?.handler())
      .rejects.toThrow('background-maintenance operations failed');
  });

  it('does not register a global turn-end listener for shard compression guidance', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('createCompressionGuidelineEvolution({');
    expect(source).not.toContain("eventBus.on('agent.turn.end'");
    expect(source).not.toContain("id: 'compaction-guideline-review'");
  });
});
