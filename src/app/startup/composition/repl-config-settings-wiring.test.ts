import { describe, it, expect } from 'vitest';
import { buildReplConfig } from './parity.js';
import { DEFAULT_REPL_CONFIG } from '../../../core/tools/analysis-workbench/types.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

// Wiring proof (bead zet.6): an operator-set analysis-workbench execution
// setting must reach the live REPLConfig consumed by the sandbox loop
// (loop.ts calls sandbox.execute(code, config.executionTimeoutMs,
// config.outputTruncation)). A persisted-but-ignored setting is a blocking
// defect, so this asserts the value actually threads through buildReplConfig.
describe('buildReplConfig — analysis-workbench execution settings wiring', () => {
  it('threads operator-set executionTimeoutMs and outputTruncation into REPLConfig', () => {
    const config = {
      analysisWorkbenchExecutionTimeoutMs: 12_345,
      analysisWorkbenchOutputTruncation: 4_096,
    } as SubstrateConfig;

    const replConfig = buildReplConfig(config);

    expect(replConfig.executionTimeoutMs).toBe(12_345);
    expect(replConfig.outputTruncation).toBe(4_096);
  });

  it('preserves compiled defaults exactly when unset', () => {
    const replConfig = buildReplConfig({} as SubstrateConfig);

    expect(replConfig.executionTimeoutMs).toBe(DEFAULT_REPL_CONFIG.executionTimeoutMs);
    expect(replConfig.outputTruncation).toBe(DEFAULT_REPL_CONFIG.outputTruncation);
    expect(replConfig.executionTimeoutMs).toBe(5_000);
    expect(replConfig.outputTruncation).toBe(8_192);
  });
});

describe('buildReplConfig — analysisWorkbenchMaxIterations wiring', () => {
  it('keeps the default iteration cap and tier ceilings when unset', () => {
    const replConfig = buildReplConfig({} as SubstrateConfig);

    expect(replConfig.budget.maxIterations).toBe(15);
    expect(replConfig.tierBudgets).toEqual(DEFAULT_REPL_CONFIG.tierBudgets);
    expect(replConfig.tierBudgets.nursery.maxIterations).toBe(5);
    expect(replConfig.tierBudgets.apprentice.maxIterations).toBe(10);
    expect(replConfig.tierBudgets.autonomous.maxIterations).toBe(15);
  });

  it('threads an operator-set cap into budget and lifts every tier ceiling', () => {
    const replConfig = buildReplConfig({
      analysisWorkbenchMaxIterations: 50,
    } as SubstrateConfig);

    expect(replConfig.budget.maxIterations).toBe(50);
    expect(replConfig.tierBudgets.nursery.maxIterations).toBe(50);
    expect(replConfig.tierBudgets.apprentice.maxIterations).toBe(50);
    expect(replConfig.tierBudgets.autonomous.maxIterations).toBe(50);
    // Non-iteration tier budget fields stay at their compiled defaults.
    expect(replConfig.tierBudgets.nursery.maxSubQueries).toBe(10);
    expect(replConfig.tierBudgets.autonomous.maxWallTimeMs).toBe(300_000);
    // The shared DEFAULT_REPL_CONFIG tier budgets must not be mutated.
    expect(DEFAULT_REPL_CONFIG.tierBudgets.nursery.maxIterations).toBe(5);
    expect(DEFAULT_REPL_CONFIG.tierBudgets.autonomous.maxIterations).toBe(15);
  });

  it('never lowers a tier ceiling below its compiled default', () => {
    const replConfig = buildReplConfig({
      analysisWorkbenchMaxIterations: 8,
    } as SubstrateConfig);

    expect(replConfig.budget.maxIterations).toBe(8);
    expect(replConfig.tierBudgets.nursery.maxIterations).toBe(8);
    expect(replConfig.tierBudgets.apprentice.maxIterations).toBe(10);
    expect(replConfig.tierBudgets.autonomous.maxIterations).toBe(15);
  });
});
