// ── RLM Iteration Loop ──
// Runs an ephemeral think cycle: LLM → code → output → repeat until FINAL.

import type { ContextMessage } from '../types.js';
import type { REPLDeps, ThinkResult } from './types.js';
import { REPLSandbox } from './sandbox.js';
import { RLM_SYSTEM_PROMPT } from './prompt.js';
import { parseResponse } from './parse.js';

export async function runRLMLoop(task: string, deps: REPLDeps): Promise<ThinkResult> {
  const startTime = Date.now();
  const { config, llmProvider } = deps;

  const sandbox = new REPLSandbox({
    llmProvider,
    embeddingService: deps.embeddingService,
    memoryStore: deps.memoryStore,
    sessionManager: deps.sessionManager,
  });

  const messages: ContextMessage[] = [
    { role: 'user', content: task },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < config.maxIterations; i++) {
    const response = await llmProvider.complete(
      { systemPrompt: RLM_SYSTEM_PROMPT, messages },
      'extraction',
    );

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    const text = response.content;
    messages.push({ role: 'assistant', content: text });

    const action = parseResponse(text);

    switch (action.type) {
      case 'final':
        return {
          answer: action.answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          durationMs: Date.now() - startTime,
          truncated: false,
        };

      case 'final_var': {
        const locals = sandbox.getLocals();
        const value = locals[action.varName];
        const answer = value !== undefined ? String(value) : `[Variable "${action.varName}" not found]`;
        return {
          answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          durationMs: Date.now() - startTime,
          truncated: false,
        };
      }

      case 'code': {
        const result = await sandbox.execute(action.code, config.executionTimeoutMs, config.outputTruncation);

        if (result.finalAnswer !== null) {
          return {
            answer: result.finalAnswer,
            iterations: i + 1,
            totalInputTokens,
            totalOutputTokens,
            durationMs: Date.now() - startTime,
            truncated: false,
          };
        }

        // Format execution output for the LLM
        let feedback = '';
        if (result.output) feedback += result.output;
        if (result.error) feedback += (feedback ? '\n' : '') + `Error: ${result.error}`;
        if (!feedback) feedback = '[No output]';

        messages.push({ role: 'user', content: feedback });
        break;
      }

      case 'none':
        messages.push({
          role: 'user',
          content: 'Please write a ```repl code block to execute, or call FINAL("your answer") when done.',
        });
        break;
    }
  }

  // Max iterations exhausted — return last assistant message
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  return {
    answer: lastAssistant?.content ?? '[No response generated]',
    iterations: config.maxIterations,
    totalInputTokens,
    totalOutputTokens,
    durationMs: Date.now() - startTime,
    truncated: true,
  };
}
