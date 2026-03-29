import type { LLMProviderPort, LLMRequestMetadata } from '../../../core/agent/contracts.js';
import type { ThinkEvidence } from '../../../core/tools/think/types.js';
import type { SandboxBudgetRef } from './contracts.js';
import { addEvidence, BUDGET_EXCEEDED_MESSAGE } from './common.js';

export interface LLMCapabilities {
  llm_query: (prompt: string) => Promise<string>;
  llm_query_strict: (prompt: string, validatePattern?: string, maxRetries?: number) => Promise<string>;
  llm_query_json: (prompt: string, maxRetries?: number) => Promise<unknown>;
}

interface CreateLLMCapabilitiesOptions {
  llmProvider: LLMProviderPort;
  budgetRef?: SandboxBudgetRef;
  pushEvidence: (entry: ThinkEvidence) => void;
  requestMetadata?: Partial<LLMRequestMetadata>;
}

export function createLLMCapabilities(options: CreateLLMCapabilitiesOptions): LLMCapabilities {
  const baseRequestId = options.requestMetadata?.requestId?.trim();
  const baseTurnId = options.requestMetadata?.turnId?.trim();
  const baseChannelId = options.requestMetadata?.channelId?.trim();
  const baseToolCallId = options.requestMetadata?.toolCallId?.trim();

  const runSubQuery = async (prompt: string, evidenceQuery: string, attempt?: number): Promise<string> => {
    if (options.budgetRef && options.budgetRef.subQueries >= options.budgetRef.maxSubQueries) {
      return BUDGET_EXCEEDED_MESSAGE;
    }
    if (options.budgetRef) {
      options.budgetRef.subQueries++;
    }

    const response = await options.llmProvider.complete(
      {
        systemPrompt: 'You are a helpful assistant. Answer concisely.',
        messages: [{ role: 'user', content: prompt }],
        correlation: {
          ...(baseTurnId ? { turnId: baseTurnId } : {}),
          requestId: baseRequestId
            ? `${baseRequestId}:sandbox-subquery:${attempt ?? 1}`
            : `repl-llm-query-${Date.now()}-${attempt ?? 1}`,
          ...(baseChannelId ? { channelId: baseChannelId } : {}),
          callType: 'tool',
          toolName: 'llm_query',
          ...(baseToolCallId ? { toolCallId: baseToolCallId } : {}),
          purpose: attempt ? 'repl.sandbox.llm_query.retry' : 'repl.sandbox.llm_query',
          originType: 'tool',
          originStage: attempt ? 'repl.sandbox.llm_query.retry' : 'repl.sandbox.llm_query',
        },
      },
      'reasoning',
    );

    addEvidence(options.pushEvidence, {
      source: 'llm_query',
      query: evidenceQuery,
      snippet: response.content,
      attempt,
    });

    return response.content;
  };

  const llm_query = async (prompt: string): Promise<string> => runSubQuery(prompt, prompt);

  const llm_query_strict = async (
    prompt: string,
    validatePattern?: string,
    maxRetries?: number,
  ): Promise<string> => {
    const retries = typeof maxRetries === 'number' && Number.isFinite(maxRetries)
      ? Math.max(1, Math.floor(maxRetries))
      : 3;
    let lastResult = '';

    for (let attempt = 0; attempt < retries; attempt++) {
      const effectivePrompt = attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous response was invalid (attempt ${attempt}/${retries}). ` +
          `Output must match pattern: ${validatePattern}\n` +
          `Previous output: ${lastResult.slice(0, 200)}`;

      const result = await runSubQuery(effectivePrompt, prompt, attempt + 1);
      if (result === BUDGET_EXCEEDED_MESSAGE) {
        return result;
      }
      lastResult = result;

      if (!validatePattern) {
        return lastResult;
      }

      try {
        if (new RegExp(validatePattern).test(lastResult)) {
          return lastResult;
        }
      } catch {
        return lastResult;
      }
    }

    return lastResult;
  };

  const llm_query_json = async (prompt: string, maxRetries?: number): Promise<unknown> => {
    const result = await llm_query_strict(
      `${prompt}\n\nRespond with valid JSON only, no markdown.`,
      '^\\s*[\\{\\[]',
      maxRetries,
    );
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  };

  return {
    llm_query,
    llm_query_strict,
    llm_query_json,
  };
}
