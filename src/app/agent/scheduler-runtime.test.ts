import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { BackgroundMaintenanceRegistry } from '../../core/scheduler/background-maintenance.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../system/config/automata-policy-config.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
  AUTOMATA_BUS_REVIEWER_TASK_ID,
  registerAutomataBusReviewerTask,
  SHARED_WORLD_WIKI_CARETAKER_OPERATION_ID,
  registerSharedWorldWikiCaretakerOperation,
  registerSalienceDecayOperation,
} from './scheduler-runtime.js';
import { registerDurableBackgroundWorkSupervisorTask } from '../../core/agent/background-work/scheduler-task.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('agent scheduler runtime wiring', () => {
  it('wires the core concern worker into the deadline-aware scheduler supervisor', () => {
    const schedulerSource = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');
    const mainSource = readFileSync(join(SRC_DIR, 'main.ts'), 'utf-8');

    expect(schedulerSource).toContain('registerConcernReviewSupervisorTask({');
    expect(schedulerSource).toContain('worker: options.concernReviewWorker');
    expect(mainSource).toContain('concernReviewWorker: coreRuntime.automatedConcernRuntime.worker');
  });

  it('registers ambient presence on the shared background-maintenance task', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('registerAmbientPresenceOperation({');
    expect(source).toContain('backgroundMaintenance,');
    expect(source).toContain('restWindow: options.schedulerConfig.episodicProcessing');
  });

  it('registers the durable background supervisor on the existing scheduler', async () => {
    const scheduler = new Scheduler(new EventBus());
    const tickBackgroundWork = vi.fn(async () => undefined);

    registerDurableBackgroundWorkSupervisorTask({
      agentLoop: {
        hasDurableBackgroundWorkSupervisor: () => true,
        tickBackgroundWork,
      },
      intervalMs: 25,
      scheduler,
    });

    expect(BACKGROUND_WORK_SUPERVISOR_TASK_ID).toBe('background-work-supervisor');
    const task = scheduler.getTask(BACKGROUND_WORK_SUPERVISOR_TASK_ID);
    expect(task).toMatchObject({
      intervalMs: 25,
      type: 'every',
      state: 'idle',
    });
    await task?.handler();
    expect(tickBackgroundWork).toHaveBeenCalledOnce();
  });

  it('runs the owner-cadenced reviewer as a registered terminal Automata run', async () => {
    const scheduler = new Scheduler(new EventBus());
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-a',
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });
    const run = vi.fn(async () => ({
      status: 'completed' as const,
      health: 'healthy' as const,
      attempted: 0,
      skippedHandled: 0,
      backlog: {
        findingsScanned: 0,
        nominationsSeen: 0,
        clustersReturned: 0,
        hasMore: false,
        remainingClusters: 0,
      },
      outcomes: { applied: 0, noChange: 0, uncertain: 0, partial: 0, failed: 0, stale: 0 },
    }));

    registerAutomataBusReviewerTask({
      scheduler,
      registry,
      companionId: 'companion-a',
      task: {
        enabled: true,
        cadenceMs: 12_345,
        run,
        readHealth: async () => ({ status: 'healthy', pendingClusters: 0, outcomes: {
          applied: 0, noChange: 0, uncertain: 0, partial: 0, failed: 0, stale: 0,
        } }),
      },
    });

    const task = scheduler.getTask(AUTOMATA_BUS_REVIEWER_TASK_ID);
    expect(task).toMatchObject({
      intervalMs: 12_345,
      availability: 'do_not_disturb',
      scheduleSource: 'automata-policy.json > bus.reviewer.cadenceMs',
    });
    await task?.handler();

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'confidential',
      runId: expect.stringMatching(/^automata-bus-review:/u),
    }));
    expect(registry.listRuns({ classId: 'scheduler.automata_bus_reviewer' })[0])
      .toMatchObject({ status: 'completed', outcome: 'completed' });
  });

  it('rejects background task registration without a durable supervisor', () => {
    const scheduler = new Scheduler(new EventBus());

    expect(() => registerDurableBackgroundWorkSupervisorTask({
      agentLoop: {
        hasDurableBackgroundWorkSupervisor: () => false,
        tickBackgroundWork: async () => undefined,
      },
      intervalMs: 250,
      scheduler,
    })).toThrow('Agent scheduler requires a durable background work supervisor');
    expect(scheduler.getTask(BACKGROUND_WORK_SUPERVISOR_TASK_ID)).toBeUndefined();
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
