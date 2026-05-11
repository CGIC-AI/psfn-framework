import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAnalysisWorkbenchTool } from './tools.js';
import { DEFAULT_REPL_CONFIG } from './types.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { runRLMLoop } from './loop.js';

vi.mock('./loop.js', () => ({
  runRLMLoop: vi.fn(),
}));

describe('createAnalysisWorkbenchTool', () => {
  beforeEach(() => {
    vi.mocked(runRLMLoop).mockReset();
  });

  it('describes the analysis workbench as a bounded large-context tool', () => {
    const tool = createAnalysisWorkbenchTool({
      llmProvider: {} as any,
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    expect(tool.name).toBe('analysis_workbench');
    expect(tool.description).toContain('large files, codebases, logs, transcripts, datasets, or evidence sets');
    expect(tool.description).toContain('Use direct semantic tools first');
    expect(tool.description).toContain('use tool_search/toolset');
    expect(tool.description).toContain('Do not use this for routine reasoning, tool discovery');
    expect(tool.description).toContain('routine orient actions, concern maintenance, scheduler/schedule work');
    expect(tool.description).toContain('simple lookup');
    expect(tool.description).toContain('Pass only the task');
  });

  it('marks truncated analysis workbench results as tool errors', async () => {
    vi.mocked(runRLMLoop).mockResolvedValue({
      answer: '[Analysis workbench loop stopped: token budget]',
      iterations: 2,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      durationMs: 5,
      truncated: true,
      budgetStatus: {
        iterations: 2,
        totalTokens: 20,
        wallTimeMs: 5,
        subQueries: 0,
        toolCalls: 0,
        sessionCostUsd: 0,
        dayCostUsd: 0,
        warnings: [],
        exceeded: 'token budget',
      },
      steps: [],
      evidence: [],
      diagnostics: {
        nestedAnalysisCallCount: 0,
        nestedAnalysisSuccessCount: 0,
        nestedAnalysisFailureCount: 0,
        maxNestedAnalysisDepthReached: 0,
      },
    });

    const tool = createAnalysisWorkbenchTool({
      llmProvider: {} as any,
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    const result = await tool.execute('analysis-call-2', { task: 'inspect token budget' });

    expect(result.details.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain('stopped: token budget');
  });

  it('records analysis workbench evidence into the active focus session context when channel metadata is available', async () => {
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
        nestedAnalysisCallCount: 0,
        nestedAnalysisSuccessCount: 0,
        nestedAnalysisFailureCount: 0,
        maxNestedAnalysisDepthReached: 0,
      },
    });

    const sessionManager = {
      recordFocusEvidence: vi.fn(),
    };
    const tool = createAnalysisWorkbenchTool({
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
      () => tool.execute('analysis-call-1', { task: 'inspect focus' }),
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
