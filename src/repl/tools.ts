// ── think tool ──
// Registered on the parent SubstrateAgent. Runs an ephemeral RLM loop for deep reasoning.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { REPLDeps } from './types.js';
import { runRLMLoop } from './loop.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

export function createThinkTool(deps: REPLDeps): AgentTool<any> {
  return {
    name: 'think',
    description:
      'Deep analytical thinking via code execution. Use for memory exploration, ' +
      'pattern recognition, data analysis, and complex reasoning tasks. ' +
      'Runs an iterative code sandbox that can query memories and sub-LMs.',
    label: 'think',
    parameters: Type.Object({
      task: Type.String({ description: 'The analytical task or question to reason through' }),
      maxIterations: Type.Optional(Type.Number({ description: 'Override max iterations (default 15)' })),
      maxTokens: Type.Optional(Type.Number({ description: 'Override max tokens (default 100000)' })),
    }),
    execute: async (
      _toolCallId: string,
      params: { task: string; maxIterations?: number; maxTokens?: number },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        // Merge budget overrides from tool input
        const effectiveDeps: REPLDeps = { ...deps };
        if (params.maxIterations !== undefined || params.maxTokens !== undefined) {
          effectiveDeps.config = {
            ...deps.config,
            budget: {
              ...deps.config.budget,
              ...(params.maxIterations !== undefined ? { maxIterations: params.maxIterations } : {}),
              ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
            },
          };
        }

        const result = await runRLMLoop(params.task, effectiveDeps);

        if (effectiveDeps.eventBus) {
          await effectiveDeps.eventBus.emit('agent.think.trace', {
            timestamp: Date.now(),
            task: params.task,
            result: {
              iterations: result.iterations,
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              durationMs: result.durationMs,
              truncated: result.truncated,
              budgetStop: result.budgetStatus.exceeded,
              steps: result.steps.map(step => ({
                iteration: step.iteration,
                timestamp: step.timestamp,
                code: step.code,
                output: '',
                error: step.error ? '[sandbox error omitted from trace]' : null,
                inputTokens: step.inputTokens,
                outputTokens: step.outputTokens,
                cumulativeTokens: step.cumulativeTokens,
                durationMs: step.durationMs,
                variablesChanged: step.variablesChanged,
              })),
            },
          });
        }

        const totalTokens = result.totalInputTokens + result.totalOutputTokens;
        const tokenBudget = effectiveDeps.config.budget.maxTokens ?? 100_000;
        const evidenceCount = result.evidence.length;
        const header =
          `[Think: ${result.iterations} iter${result.iterations !== 1 ? 's' : ''}, ` +
          `${totalTokens}/${tokenBudget} tokens, ` +
          `${result.durationMs}ms` +
          `${evidenceCount > 0 ? `, ${evidenceCount} evidence` : ''}` +
          `${result.truncated ? ', truncated' : ''}` +
          `${result.budgetStatus.exceeded ? `, stopped: ${result.budgetStatus.exceeded}` : ''}]`;

        return {
          content: [{ type: 'text', text: `${header}\n\n${result.answer}` }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        return textResultWithError(`[Think error: ${toErrorMessage(error)}]`, true);
      }
    },
  };
}
