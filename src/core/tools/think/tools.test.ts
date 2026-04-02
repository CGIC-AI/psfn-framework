import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createThinkTool } from './tools.js';
import { DEFAULT_REPL_CONFIG } from './types.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { runRLMLoop } from './loop.js';

vi.mock('./loop.js', () => ({
  runRLMLoop: vi.fn(),
}));

describe('createThinkTool', () => {
  beforeEach(() => {
    vi.mocked(runRLMLoop).mockReset();
  });

  it('describes think as an explicit fallback after direct tools', () => {
    const tool = createThinkTool({
      llmProvider: {} as any,
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    expect(tool.description).toContain('Explicit fallback analytical thinking via code execution.');
    expect(tool.description).toContain('Reach for direct tools first');
    expect(tool.description).toContain('use tool_search/toolset before think when the active stack is missing the needed capability');
    expect(tool.description).toContain('not for routine file lookup, simple reads, basic inspection, or routine state changes');
  });

  it('records think evidence into the active focus session context when channel metadata is available', async () => {
    vi.mocked(runRLMLoop).mockResolvedValue({
      answer: 'done',
      iterations: 1,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      durationMs: 5,
      truncated: false,
      budgetStatus: {
        iterations: 1,
        totalTokens: 20,
        wallTimeMs: 5,
        subQueries: 0,
        toolCalls: 0,
        sessionCostUsd: 0,
        dayCostUsd: 0,
        warnings: [],
        exceeded: null,
      },
      steps: [],
      evidence: [{
        source: 'llm_query',
        query: 'focus query',
        snippet: 'focus evidence snippet',
        resultCount: 1,
        timestamp: 1_700_000_000_000,
      }],
      diagnostics: {
        nestedThinkCallCount: 0,
        nestedThinkSuccessCount: 0,
        nestedThinkFailureCount: 0,
        maxNestedDepthReached: 0,
      },
    });

    const sessionManager = {
      recordFocusEvidence: vi.fn(),
    };
    const tool = createThinkTool({
      llmProvider: {} as any,
      embeddingService: null,
      memoryStore: null,
      sessionManager: sessionManager as any,
      config: DEFAULT_REPL_CONFIG,
    });

    await runWithRequestContext(
      {
        callType: 'tool',
        purpose: 'agent.turn',
        channelId: 'api:focus-evidence',
      },
      () => tool.execute('think-call-1', { task: 'inspect focus' }),
    );

    expect(sessionManager.recordFocusEvidence).toHaveBeenCalledWith(
      'api:focus-evidence',
      expect.arrayContaining([
        expect.objectContaining({
          source: 'llm_query',
          snippet: 'focus evidence snippet',
        }),
      ]),
    );
  });
});
