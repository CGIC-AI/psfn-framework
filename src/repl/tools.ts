// ── think tool ──
// Registered on the parent AgentLoop. Runs an ephemeral RLM loop for deep reasoning.

import type { SubstrateTool } from '../types.js';
import type { REPLDeps } from './types.js';
import { runRLMLoop } from './loop.js';

export function createThinkTool(deps: REPLDeps): SubstrateTool {
  return {
    name: 'think',
    description:
      'Deep analytical thinking via code execution. Use for memory exploration, ' +
      'pattern recognition, data analysis, and complex reasoning tasks. ' +
      'Runs an iterative code sandbox that can query memories and sub-LMs.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The analytical task or question to reason through',
        },
        maxIterations: {
          type: 'number',
          description: 'Override max iterations (default 15)',
        },
        maxTokens: {
          type: 'number',
          description: 'Override max tokens (default 100000)',
        },
      },
      required: ['task'],
    },
    execute: async (input) => {
      try {
        // Merge budget overrides from tool input
        const effectiveDeps: REPLDeps = { ...deps };
        if (input.maxIterations !== undefined || input.maxTokens !== undefined) {
          effectiveDeps.config = {
            ...deps.config,
            budget: {
              ...deps.config.budget,
              ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations as number } : {}),
              ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens as number } : {}),
            },
          };
        }

        const result = await runRLMLoop(input.task as string, effectiveDeps);

        const totalTokens = result.totalInputTokens + result.totalOutputTokens;
        const tokenBudget = effectiveDeps.config.budget.maxTokens ?? 100_000;
        const header =
          `[Think: ${result.iterations} iter${result.iterations !== 1 ? 's' : ''}, ` +
          `${totalTokens}/${tokenBudget} tokens, ` +
          `${result.durationMs}ms` +
          `${result.truncated ? ', truncated' : ''}` +
          `${result.budgetStatus.exceeded ? `, stopped: ${result.budgetStatus.exceeded}` : ''}]`;

        return { content: `${header}\n\n${result.answer}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `[Think error: ${msg}]`, isError: true };
      }
    },
  };
}
