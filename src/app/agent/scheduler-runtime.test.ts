import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { registerSalienceDecayTask } from './scheduler-runtime.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('agent scheduler runtime wiring', () => {
  it('registers ambient presence as a scheduler-owned internal task', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('registerAmbientPresenceTask({');
    expect(source).toContain('restWindow: options.schedulerConfig.episodicProcessing');
  });

  it('registers salience decay from its dedicated runtime key', () => {
    const scheduler = new Scheduler(new EventBus());
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    registerSalienceDecayTask({
      scheduler,
      memoryStore: {} as MemoryStorePort,
      intervalMs: 3_600_000,
    });

    expect(scheduler.getTask('salience-decay')?.intervalMs).toBe(3_600_000);
    expect(source).toContain('intervalMs: options.config.salienceDecayIntervalMs');
    expect(source).not.toContain('intervalMs: options.config.maintenanceIntervalMs');
  });

  it('bundles compression-guideline review into heartbeat instead of a decay-cadence task', () => {
    const source = readFileSync(join(SRC_DIR, 'scheduler-runtime.ts'), 'utf-8');

    expect(source).toContain('scheduler.registerHeartbeat(async () => {');
    expect(source).toContain('runPeriodicCompressionGuidelineUpdate');
    expect(source).not.toContain("id: 'compaction-guideline-review'");
  });
});
