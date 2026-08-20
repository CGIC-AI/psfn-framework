import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { createAnalysisWorkbenchTool } from './tools.js';
import { DEFAULT_REPL_CONFIG } from './types.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../agent/tool-surface/descriptions.js';
import { runRLMLoop } from './loop.js';
import type { SessionManager } from '../../session/manager.js';

vi.mock('./loop.js', () => ({
  runRLMLoop: vi.fn(),
}));

describe('createAnalysisWorkbenchTool', () => {
  beforeEach(() => {
    vi.mocked(runRLMLoop).mockReset();
  });

  it('uses the canonical analysis workbench description', () => {
    const tool = createAnalysisWorkbenchTool({
      llmProvider: fromPartial({}),
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    expect(tool.name).toBe('analysis_workbench');
    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.analysis_workbench);
    expect(tool.description).not.toMatch(/(?:missing|absent)[^.]*capabil|capabil[^.]*(?:missing|absent)/iu);
  });

  it('rejects a caller override above the owner-controlled iteration ceiling', async () => {
    const tool = createAnalysisWorkbenchTool({
      llmProvider: fromPartial({}),
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    const result = await tool.execute('analysis-call-ceiling', {
      task: 'bypass owner limit',
      maxIterations: 61,
    });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(result.details.isError).toBe(true);
    expect(text).toContain('maxIterations cannot exceed the owner-controlled ceiling of 60');
  });

  it('marks truncated analysis workbench results as tool errors', async () => {
    vi.mocked(runRLMLoop).mockResolvedValue({
      answer: '[Analysis workbench loop stopped: token budget]',
      outcome: 'limit_reached',
      continuation: 'restart_required',
      limitPolicy: {
        maxIterations: 60,
        maxTokens: 256_000,
        maxWallTimeMs: 600_000,
        maxSubQueries: 60,
        maxToolCalls: 50,
      },
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
        sessionCostUsd: 0.125,
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
      llmProvider: fromPartial({}),
      embeddingService: null,
      memoryStore: null,
      sessionManager: null,
      config: DEFAULT_REPL_CONFIG,
    });

    const result = await tool.execute('analysis-call-2', { task: 'inspect token budget' });

    expect(result.details.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('outcome: limit_reached');
    expect(text).toContain('continuation: restart_required');
    expect(text).toContain('2/60 iterations');
    expect(text).toContain('cost: $0.1250');
    expect(text).toContain('stopped: token budget');
  });

  it('records analysis workbench evidence into the active focus session context when channel metadata is available', async () => {
    vi.mocked(runRLMLoop).mockResolvedValue({
      answer: 'done',
      outcome: 'completed',
      continuation: 'not_needed',
      limitPolicy: {
        maxIterations: 60,
        maxTokens: 256_000,
        maxWallTimeMs: 600_000,
        maxSubQueries: 60,
        maxToolCalls: 50,
      },
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

    const sessionManager = fromPartial<SessionManager>({ recordFocusEvidence: vi.fn() });
    const tool = createAnalysisWorkbenchTool({
      llmProvider: fromPartial({}),
      embeddingService: null,
      memoryStore: null,
      sessionManager,
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
