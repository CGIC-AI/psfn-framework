// ── analysis workbench tool ──
// Registered on the parent SubstrateAgent. Runs an ephemeral RLM loop for bounded analysis.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { REPLDeps } from './types.js';
import { runRLMLoop } from './loop.js';
import { textResultWithError } from '../results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';

export function createAnalysisWorkbenchTool(deps: REPLDeps): AgentTool<any> {
  return {
    name: 'analysis_workbench',
    description:
      'Bounded analysis workbench for large files, codebases, logs, datasets, or evidence sets that would ' +
      'bloat the main conversation context. Use direct semantic tools first, and use tool_search/toolset ' +
      'when the active stack is missing a capability. Do not use this for routine reasoning, tool discovery, ' +
      'schema confusion, simple file lookup, basic inspection, or routine state changes. Pass only the task ' +
      'or question to analyze; the tool manages its own temporary scratchpad and iterative code sandbox.',
    label: 'analysis_workbench',
    parameters: Type.Object({
      task: Type.String({ description: 'The analytical task or question to reason through' }),
      maxIterations: Type.Optional(Type.Number({ description: 'Override max iterations (default 15)' })),
      maxTokens: Type.Optional(Type.Number({ description: 'Override max tokens (default 100000)' })),
    }),
    execute: async (
      toolCallId: string,
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

        const result = await runRLMLoop(
          params.task,
          effectiveDeps,
          {
            toolName: 'analysis_workbench',
            toolCallId,
            originType: 'tool',
            originStage: 'repl.analysis_workbench.tool',
          },
        );

        if (effectiveDeps.costTelemetry) {
          const requestContext = getRequestContext();
          await effectiveDeps.costTelemetry.recordThinkTrace({
            timestamp: Date.now(),
            task: params.task,
            ...(requestContext?.channelId ? { channelId: requestContext.channelId } : {}),
            ...(requestContext?.requestId ? { requestId: requestContext.requestId } : {}),
            ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
            toolName: 'analysis_workbench',
            toolCallId,
            originType: 'tool',
            originStage: 'repl.analysis_workbench.tool',
            result: {
              iterations: result.iterations,
              totalInputTokens: result.totalInputTokens,
              totalOutputTokens: result.totalOutputTokens,
              durationMs: result.durationMs,
              truncated: result.truncated,
              budgetStop: result.budgetStatus.exceeded,
              subQueries: result.budgetStatus.subQueries,
              toolCalls: result.budgetStatus.toolCalls,
              sessionCostUsd: result.budgetStatus.sessionCostUsd,
              warnings: [...result.budgetStatus.warnings],
              nestedThink: result.diagnostics,
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

        const requestContext = getRequestContext();
        if (requestContext?.channelId && effectiveDeps.sessionManager && result.evidence.length > 0) {
          effectiveDeps.sessionManager.recordFocusEvidence(requestContext.channelId, result.evidence);
        }

        const totalTokens = result.totalInputTokens + result.totalOutputTokens;
        const tokenBudget = effectiveDeps.config.budget.maxTokens ?? 100_000;
        const evidenceCount = result.evidence.length;
        const nestedThinkCount = result.diagnostics.nestedThinkSuccessCount;
        const header =
          `[Analysis workbench: ${result.iterations} iter${result.iterations !== 1 ? 's' : ''}, ` +
          `${totalTokens}/${tokenBudget} tokens, ` +
          `${result.durationMs}ms` +
          `${nestedThinkCount > 0 ? `, ${nestedThinkCount} nested analysis` : ''}` +
          `${evidenceCount > 0 ? `, ${evidenceCount} evidence` : ''}` +
          `${result.truncated ? ', truncated' : ''}` +
          `${result.budgetStatus.exceeded ? `, stopped: ${result.budgetStatus.exceeded}` : ''}]`;
        const isError = result.truncated || result.budgetStatus.exceeded !== null;

        return {
          content: [{ type: 'text', text: `${header}\n\n${result.answer}` }] satisfies TextContent[],
          details: { isError: isError || undefined },
        };
      } catch (error) {
        return textResultWithError(`[Analysis workbench error: ${toErrorMessage(error)}]`, true);
      }
    },
  };
}
