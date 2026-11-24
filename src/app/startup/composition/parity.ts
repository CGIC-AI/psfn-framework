// Shared runtime wiring.
// Pure core wiring lives in `./core-parity.ts` so full-framework entrypoints
// and standalone companion composition share one implementation.

import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ToolRegistrarTarget } from '../../../core/agent/tool-registrar.js';
import {
  DEFAULT_REPL_CONFIG,
  type REPLConfig,
  type TierAnalysisWorkbenchBudget,
  validateAnalysisWorkbenchDirectResponseTimeoutMs,
} from '../../../core/tools/analysis-workbench/types.js';
import {
  wireFilesystemRuntime,
  type FilesystemRuntimeTarget,
} from '../../../boundary/integrations/filesystem/runtime-wiring.js';

export {
  buildCharacterPromptVariablesProvider,
  wireCharacterCardRuntime,
  wirePromptRuntime,
  wireReflectionRuntime,
  wireSessionToolsRuntime,
  wireSettingsRuntime,
  wireStaticPromptRegistry,
  type CharacterCardRuntimeTarget,
  type PromptCacheInvalidationOptions,
  type PromptRuntimeTarget,
} from './core-parity.js';

export type FilesystemToolRuntimeTarget = ToolRegistrarTarget & FilesystemRuntimeTarget;

/**
 * Build REPL config with runtime settings overrides.
 * Shared across the split runtime entrypoints to keep analysis workbench budgets aligned.
 */
export function buildReplConfig(config: SubstrateConfig): REPLConfig {
  const replConfig: REPLConfig = {
    ...DEFAULT_REPL_CONFIG,
    budget: { ...DEFAULT_REPL_CONFIG.budget },
  };
  if (config.analysisWorkbenchMaxTokens !== undefined) replConfig.budget.maxTokens = config.analysisWorkbenchMaxTokens;
  if (config.analysisWorkbenchMaxWallTimeMs !== undefined) replConfig.budget.maxWallTimeMs = config.analysisWorkbenchMaxWallTimeMs;
  if (config.analysisWorkbenchDirectResponseTimeoutMs !== undefined) {
    replConfig.directResponseTimeoutMs = validateAnalysisWorkbenchDirectResponseTimeoutMs(
      config.analysisWorkbenchDirectResponseTimeoutMs,
    );
  }
  if (config.analysisWorkbenchMaxSubQueries !== undefined) replConfig.budget.maxSubQueries = config.analysisWorkbenchMaxSubQueries;
  if (config.analysisWorkbenchMaxIterations !== undefined) {
    replConfig.budget.maxIterations = config.analysisWorkbenchMaxIterations;
  }
  if (
    config.analysisWorkbenchMaxIterations !== undefined
    || config.analysisWorkbenchMaxWallTimeMs !== undefined
    || config.analysisWorkbenchMaxSubQueries !== undefined
  ) {
    const liftTierCeilings = (tier: TierAnalysisWorkbenchBudget): TierAnalysisWorkbenchBudget => ({
      ...tier,
      maxIterations: config.analysisWorkbenchMaxIterations === undefined
        ? tier.maxIterations
        : Math.max(tier.maxIterations, config.analysisWorkbenchMaxIterations),
      maxWallTimeMs: config.analysisWorkbenchMaxWallTimeMs === undefined
        ? tier.maxWallTimeMs
        : Math.max(tier.maxWallTimeMs, config.analysisWorkbenchMaxWallTimeMs),
      maxSubQueries: config.analysisWorkbenchMaxSubQueries === undefined
        ? tier.maxSubQueries
        : Math.max(tier.maxSubQueries, config.analysisWorkbenchMaxSubQueries),
    });
    replConfig.tierBudgets = {
      nursery: liftTierCeilings(replConfig.tierBudgets.nursery),
      apprentice: liftTierCeilings(replConfig.tierBudgets.apprentice),
      autonomous: liftTierCeilings(replConfig.tierBudgets.autonomous),
    };
  }
  if (config.analysisWorkbenchExecutionTimeoutMs !== undefined) replConfig.executionTimeoutMs = config.analysisWorkbenchExecutionTimeoutMs;
  if (config.analysisWorkbenchOutputTruncation !== undefined) replConfig.outputTruncation = config.analysisWorkbenchOutputTruncation;
  return replConfig;
}

export function wireFilesystemToolsRuntime(
  target: FilesystemToolRuntimeTarget,
  workspacePath: string,
  config: Pick<SubstrateConfig, 'fsReadMaxBytes'> = {},
): void {
  wireFilesystemRuntime(target, workspacePath, {
    ...(config.fsReadMaxBytes !== undefined
      ? { defaultReadMaxBytes: config.fsReadMaxBytes }
      : {}),
  });
}
