import type { NestedThinkOptions, NestedThinkRunner } from '../../../core/tools/think/types.js';

export interface ThinkCapabilities {
  sub_think: (task: string, options?: NestedThinkOptions) => Promise<string>;
}

interface CreateThinkCapabilitiesOptions {
  runNestedThink: NestedThinkRunner;
}

function normalizeNestedThinkOptions(options: NestedThinkOptions | undefined): NestedThinkOptions | undefined {
  if (!options) return undefined;
  return { ...options };
}

export function createThinkCapabilities(options: CreateThinkCapabilitiesOptions): ThinkCapabilities {
  return {
    sub_think: async (task: string, nestedOptions?: NestedThinkOptions): Promise<string> => {
      if (typeof task !== 'string' || task.trim().length === 0) {
        throw new Error('sub_think task must be a non-empty string');
      }
      return options.runNestedThink(task, normalizeNestedThinkOptions(nestedOptions));
    },
  };
}
