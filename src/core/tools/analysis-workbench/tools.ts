// ── analysis workbench tool ──
// Registered on the parent SubstrateAgent. Runs an ephemeral RLM loop for bounded analysis.

import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '../../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import type { TextContent } from '@earendil-works/pi-ai';
import type { REPLDeps } from './types.js';
import { runRLMLoop } from './loop.js';
import { textResultWithError } from '../results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../agent/tool-surface/descriptions.js';

export function createAnalysisWorkbenchTool(deps: REPLDeps): SubstrateAgentTool {
  return {
    name: 'analysis_workbench',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.analysis_workbench,
    label: 'analysis_workbench',
    parameters: Type.Object({
      task: Type.String({ description: 'The analytical task or question to reason through' }),
      maxIterations: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 60,
        description: 'Optional lower iteration limit; cannot exceed the owner-controlled ceiling (maximum 60)',
      })),
      maxTokens: Type.Optional(Type.Integer({
        minimum: 1,
        description: 'Optional lower token limit; cannot exceed the owner-controlled ceiling',
      })),
    }),
    execute: async (
      toolCallId: string,
      params: { task: string; maxIterations?: number; maxTokens?: number },
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        if (
          params.maxIterations !== undefined
          && (
            !Number.isSafeInteger(params.maxIterations)
            || params.maxIterations < 1
            || params.maxIterations > deps.config.budget.maxIterations
          )
        ) {
          throw new Error(
            `maxIterations cannot exceed the owner-controlled ceiling of ${deps.config.budget.maxIterations}`,
          );
        }
        if (
          params.maxTokens !== undefined
          && (
            !Number.isSafeInteger(params.maxTokens)
            || params.maxTokens < 1
            || (
              deps.config.budget.maxTokens !== undefined
              && params.maxTokens > deps.config.budget.maxTokens
            )
          )
        ) {
          throw new Error(
            'maxTokens must be a positive integer no greater than the owner-controlled ceiling',
          );
        }
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
          { signal },
        );

        if (effectiveDeps.costTelemetry) {
          const requestContext = getRequestContext();
          await effectiveDeps.costTelemetry.recordAnalysisWorkbenchTrace({
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
              outcome: result.outcome,
              continuation: result.continuation,
              limitPolicy: result.limitPolicy,
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
              nestedAnalysis: result.diagnostics,
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
        const tokenProgress = result.limitPolicy.maxTokens === null
          ? `${totalTokens} tokens`
          : `${totalTokens}/${result.limitPolicy.maxTokens} tokens`;
        const wallTimeProgress = result.limitPolicy.maxWallTimeMs === null
          ? `${result.durationMs}ms`
          : `${result.durationMs}/${result.limitPolicy.maxWallTimeMs}ms`;
        const evidenceCount = result.evidence.length;
        const nestedAnalysisCount = result.diagnostics.nestedAnalysisSuccessCount;
        const header =
          `[Analysis workbench outcome: ${result.outcome}; ` +
          `continuation: ${result.continuation}; ` +
          `progress: ${result.iterations}/${result.limitPolicy.maxIterations} iterations, ` +
          `${tokenProgress}, ${wallTimeProgress}; ` +
          `cost: $${result.budgetStatus.sessionCostUsd.toFixed(4)}` +
          `${nestedAnalysisCount > 0 ? `, ${nestedAnalysisCount} nested analysis` : ''}` +
          `${evidenceCount > 0 ? `, ${evidenceCount} evidence` : ''}` +
          `${result.budgetStatus.exceeded ? `; stopped: ${result.budgetStatus.exceeded}` : ''}]`;
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
