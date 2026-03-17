import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LLMProvider } from '../agent/contracts.js';
import type { SubstrateConfig } from '../types.js';
import { SessionStore } from '../session/store.js';
import { SessionManager } from '../session/manager.js';
import { runWithRequestContext } from '../llm/request-context.js';
import { createCompleteFocusTool, createStartFocusTool } from './focus.js';

function makeConfig(dataDir: string, overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 80,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 200,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 95,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 100_000 },
      context: { model: 'test-context-model', provider: 'test', maxTokens: 4096, contextWindow: 16_000 },
    },
    ...overrides,
  };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(entry => entry.text).join('\n');
}

describe('focus tools', () => {
  let dir: string;
  let store: SessionStore;
  let manager: SessionManager;
  let llmProvider: LLMProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-focus-tools-'));
    store = new SessionStore(join(dir, 'sessions'));
    manager = new SessionManager(store, makeConfig(dir));
    llmProvider = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: vi.fn(async () => ({
        content: 'Focus Summary\n- Captured actionable findings from diagnostics.\nOpen questions: none',
        toolCalls: [],
        model: 'mock-context',
        inputTokens: 25,
        outputTokens: 30,
        stopReason: 'stop',
      })),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a focus session and rejects duplicate active start calls', async () => {
    const startTool = createStartFocusTool(manager);

    const first = await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-session' },
      () => startTool.execute('focus-start-1', { scope: 'Investigate flaky test timeout' }),
    );
    expect(toolText(first as any)).toContain('start_focus: tracking');

    const second = await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-session' },
      () => startTool.execute('focus-start-2', { scope: 'Duplicate scope should fail' }),
    );
    expect(toolText(second as any)).toContain('focus session already active');
    expect((second.details as { isError?: boolean }).isError).toBe(true);
  });

  it('completes focus by persisting durable knowledge and pruning compacted focus range from context', async () => {
    const startTool = createStartFocusTool(manager);
    const completeTool = createCompleteFocusTool(manager, llmProvider);

    store.append({
      channelId: 'api:focus-context',
      role: 'user',
      content: 'Pre-focus baseline context should remain.',
      authorId: 'u1',
      authorName: 'User',
      timestamp: 1_000,
    });

    await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-context' },
      () => startTool.execute('focus-start', { scope: 'Diagnose context compaction behavior' }),
    );

    store.append({
      channelId: 'api:focus-context',
      role: 'user',
      content: 'Focus step 1 detail to compact later.',
      timestamp: 2_000,
    });
    store.append({
      channelId: 'api:focus-context',
      role: 'assistant',
      content: 'Focus step 2 finding to compact later.',
      timestamp: 3_000,
    });
    manager.recordFocusEvidence('api:focus-context', [{
      source: 'llm_query',
      query: 'compaction threshold',
      snippet: 'Compaction should aggressively collapse old context after focus completion.',
      resultCount: 1,
      timestamp: 3_100,
    }]);

    const completed = await runWithRequestContext(
      { callType: 'tool', purpose: 'agent.turn', channelId: 'api:focus-context', requestId: 'req-focus-1' },
      () => completeTool.execute('focus-complete', {
        conclusion: 'Prioritize preserving distilled findings while pruning raw exploration turns.',
      }),
    );

    expect(toolText(completed as any)).toContain('complete_focus: persisted knowledge block');
    expect((llmProvider.complete as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('context');
    const completionDetails = completed.details as {
      channelId: string;
      rangeStartId: number | null;
      rangeEndId: number | null;
    };
    expect(completionDetails.channelId).toBe('api:focus-context');
    expect(completionDetails.rangeStartId).toBe(2);
    expect(completionDetails.rangeEndId).toBe(3);
    const storedBlock = (manager as any).focusKnowledgeStore.listByChannel('api:focus-context')[0];
    expect(storedBlock).toBeDefined();
    expect(storedBlock.rangeStartId).toBe(2);
    expect(storedBlock.rangeEndId).toBe(3);
    expect((manager as any).getFocusCompactionRanges('api:focus-context')).toEqual([
      { startEntryId: 2, endEntryId: 3 },
    ]);

    const context = await manager.buildContext('api:focus-context', 'System prompt', '');
    const renderedMessages = context.messages.map(message => message.content).join('\n');
    expect(context.systemPrompt).toContain('[Focus knowledge]');
    expect(context.systemPrompt).toContain('Captured actionable findings from diagnostics');
    expect(renderedMessages).toContain('Pre-focus baseline context should remain');
    expect(renderedMessages).not.toContain('Focus step 1 detail to compact later');
    expect(renderedMessages).not.toContain('Focus step 2 finding to compact later');

    const reloadedManager = new SessionManager(
      new SessionStore(join(dir, 'sessions')),
      makeConfig(dir),
    );
    const reloadedContext = await reloadedManager.buildContext('api:focus-context', 'System prompt', '');
    const reloadedMessages = reloadedContext.messages.map(message => message.content).join('\n');
    expect(reloadedContext.systemPrompt).toContain('[Focus knowledge]');
    expect(reloadedContext.systemPrompt).toContain('Captured actionable findings from diagnostics');
    expect(reloadedMessages).toContain('Pre-focus baseline context should remain');
    expect(reloadedMessages).not.toContain('Focus step 1 detail to compact later');
    expect(reloadedMessages).not.toContain('Focus step 2 finding to compact later');
  });
});
