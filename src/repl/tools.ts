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
      },
      required: ['task'],
    },
    execute: async (input) => {
      try {
        const result = await runRLMLoop(input.task as string, deps);

        const header =
          `[Think: ${result.iterations} iter${result.iterations !== 1 ? 's' : ''}, ` +
          `${result.totalInputTokens + result.totalOutputTokens} tokens, ` +
          `${result.durationMs}ms` +
          `${result.truncated ? ', truncated' : ''}]`;

        return { content: `${header}\n\n${result.answer}` };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `[Think error: ${msg}]`, isError: true };
      }
    },
  };
}
