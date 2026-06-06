import { describe, expect, it } from 'vitest';
import { MEMORY_REGRESSION_FIXTURES } from './fixtures.js';
import { DeterministicMemoryRegressionProvider } from './provider.js';
import { runMemoryRegressionBenchmark } from './run.js';
import type {
  MemoryMaintenanceObservation,
  MemoryRegressionFixture,
  MemoryWriteObservation,
  MemoryWriteOperation,
} from './types.js';
import { REQUIRED_MEMORY_FIXTURE_FAMILIES } from './types.js';

class DuplicateEpisodeRegressionProvider extends DeterministicMemoryRegressionProvider {
  override async runMaintenance(fixture: MemoryRegressionFixture): Promise<MemoryMaintenanceObservation> {
    const observation = await super.runMaintenance({
      ...fixture,
      maintenance: {
        ...fixture.maintenance,
        expectedEpisodeMergeGroups: [],
      },
    });
    return {
      ...observation,
      mergedEpisodePairs: [],
    };
  }
}

class CompatibleFalseSupersedeRegressionProvider extends DeterministicMemoryRegressionProvider {
  override async writeMemory(operation: MemoryWriteOperation): Promise<MemoryWriteObservation> {
    const observation = await super.writeMemory(operation);
    if (!operation.compatibleUpdate) return observation;
    return {
      ...observation,
      supersededMemoryIds: ['m-tea-oolong'],
    };
  }
}

describe('memory regression benchmark', () => {
  it('covers every required fixture family and passes with the deterministic provider', async () => {
    const report = await runMemoryRegressionBenchmark({
      generatedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(new Set(MEMORY_REGRESSION_FIXTURES.map((fixture) => fixture.family))).toEqual(
      new Set(REQUIRED_MEMORY_FIXTURE_FAMILIES),
    );
    expect(report.status).toBe('pass');
    expect(report.metrics['precision@k']).toBe(1);
    expect(report.metrics['recall@k']).toBe(1);
    expect(report.metrics.false_supersede_rate).toBe(0);
    expect(report.metrics.missed_supersede_rate).toBe(0);
    expect(report.metrics.compatible_update_false_positive_rate).toBe(0);
    expect(report.metrics.episode_duplicate_rate).toBe(0);
    expect(report.metrics.merge_precision).toBe(1);
    expect(report.metrics.merge_recall).toBe(1);
    expect(report.metrics.trust_leak_rate).toBe(0);
  });

  it('fails when episodic maintenance leaves duplicate episodes active', async () => {
    const report = await runMemoryRegressionBenchmark({
      providerFactory: () => new DuplicateEpisodeRegressionProvider(),
      generatedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(report.status).toBe('fail');
    expect(report.metrics.episode_duplicate_rate).toBeGreaterThan(0);
    expect(report.metrics.merge_recall).toBeLessThan(1);
    expect(report.fixtureResults.some((result) => (
      result.failures.some((failure) => failure.includes('duplicate episode group still active'))
    ))).toBe(true);
  });

  it('fails when a compatible update is falsely superseded', async () => {
    const report = await runMemoryRegressionBenchmark({
      providerFactory: () => new CompatibleFalseSupersedeRegressionProvider(),
      generatedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(report.status).toBe('fail');
    expect(report.metrics.false_supersede_rate).toBeGreaterThan(0);
    expect(report.metrics.compatible_update_false_positive_rate).toBeGreaterThan(0);
    expect(report.fixtureResults.some((result) => (
      result.failures.some((failure) => failure.includes('compatible update write-tea-jasmine superseded'))
    ))).toBe(true);
  });
});
