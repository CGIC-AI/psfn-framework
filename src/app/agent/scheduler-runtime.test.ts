import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { BackgroundMaintenanceRegistry } from '../../core/scheduler/background-maintenance.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
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

  it('registers the durable background supervisor on the existing scheduler', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(BACKGROUND_WORK_SUPERVISOR_TASK_ID).toBe('background-work-supervisor');
    expect(source).toContain('if (!options.agentLoop.hasDurableBackgroundWorkSupervisor())');
    expect(source).toContain('handler: () => options.agentLoop.tickBackgroundWork()');
    expect(source).not.toContain('setInterval(() => options.agentLoop.tickBackgroundWork()');
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

  it('does not register a global turn-end listener for shard compression guidance', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('createCompressionGuidelineEvolution({');
    expect(source).not.toContain("eventBus.on('agent.turn.end'");
    expect(source).not.toContain("id: 'compaction-guideline-review'");
  });
});
