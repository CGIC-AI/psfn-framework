import type { NestedAnalysisOptions, NestedAnalysisRunner } from '../../../core/tools/analysis-workbench/types.js';

export interface AnalysisCapabilities {
  nested_analysis: (task: string, options?: NestedAnalysisOptions) => Promise<string>;
}

interface CreateAnalysisCapabilitiesOptions {
  runNestedAnalysis: NestedAnalysisRunner;
}

function normalizeNestedAnalysisOptions(options: NestedAnalysisOptions | undefined): NestedAnalysisOptions | undefined {
  if (!options) return undefined;
  return { ...options };
}

export function createAnalysisCapabilities(options: CreateAnalysisCapabilitiesOptions): AnalysisCapabilities {
  return {
    nested_analysis: async (task: string, nestedOptions?: NestedAnalysisOptions): Promise<string> => {
      if (typeof task !== 'string' || task.trim().length === 0) {
        throw new Error('nested_analysis task must be a non-empty string');
      }
      return options.runNestedAnalysis(task, normalizeNestedAnalysisOptions(nestedOptions));
    },
  };
}
