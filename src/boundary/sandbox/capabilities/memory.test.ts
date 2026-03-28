import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../../../agent/contracts.js';
import type { SessionManager } from '../../../session/manager.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import { createMemoryCapabilities } from './memory.js';

function mockLLM(summary = 'Summarized search results.'): LLMProvider {
  return {
    stream: vi.fn(async () => ({
      content: '',
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
      stopReason: 'end_turn',
    } satisfies LLMResponse)),
    complete: vi.fn(async () => ({
      content: summary,
      model: 'mock',
      inputTokens: 12,
      outputTokens: 24,
      toolCalls: [],
      stopReason: 'end_turn',
    } satisfies LLMResponse)),
  };
}

describe('createMemoryCapabilities session_search', () => {
  it('runs transcript search and summarizes via summary completion purpose', async () => {
    const llm = mockLLM('Kyoto notes were concentrated in two channels.');
    const sessionManager = {
      searchTranscripts: vi.fn(() => [
        {
          channelId: 'api:alpha',
          messageId: 11,
          role: 'user',
          content: 'Kyoto itinerary update',
          snippet: 'Kyoto itinerary update',
          timestamp: 1_000,
          channelVisibility: 'private',
          score: -1.2,
        },
        {
          channelId: 'api:beta',
          messageId: 12,
          role: 'assistant',
          content: 'Kyoto train reminders',
          snippet: 'Kyoto train reminders',
          timestamp: 2_000,
          channelVisibility: 'private',
          score: -1.0,
        },
      ]),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(),
    } as unknown as SessionManager;

    const capabilities = createMemoryCapabilities({
      llmProvider: llm,
      embeddingService: null,
      memoryStore: null,
      sessionManager,
      pushEvidence: vi.fn(),
    });

    const result = await capabilities.session_search('Kyoto', 5, {
      channelId: 'api:current',
      isDirectMessage: true,
      trustLevel: 'primary',
    });

    expect(result.summary).toContain('Kyoto notes');
    expect(result.hits).toHaveLength(2);
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('summary');
  });

  it('filters session_search hits with trust + channel visibility gates before summarization', async () => {
    const llm = mockLLM('Only public snippets were visible in this context.');
    const sessionManager = {
      searchTranscripts: vi.fn(() => [
        {
          channelId: 'api:private',
          messageId: 1,
          role: 'user',
          content: 'ultra-private confidences',
          snippet: 'ultra-private confidences',
          timestamp: 1_000,
          channelVisibility: 'private',
          score: -3,
        },
        {
          channelId: '1234567890',
          messageId: 2,
          role: 'assistant',
          content: 'guild planning notes',
          snippet: 'guild planning notes',
          timestamp: 2_000,
          channelVisibility: 'semi_private',
          score: -2,
        },
        {
          channelId: 'twitter:timeline',
          messageId: 3,
          role: 'assistant',
          content: 'public launch announcement',
          snippet: 'public launch announcement',
          timestamp: 3_000,
          channelVisibility: 'broadcast',
          score: -1,
        },
      ]),
      getRecentMessages: vi.fn(() => []),
      appendSystemNote: vi.fn(),
    } as unknown as SessionManager;

    const capabilities = createMemoryCapabilities({
      llmProvider: llm,
      embeddingService: null,
      memoryStore: null,
      sessionManager,
      pushEvidence: vi.fn(),
    });

    const result = await capabilities.session_search('launch', 5, {
      channelId: 'api:current',
      isDirectMessage: true,
      trustLevel: 'regular',
    });

    expect(result.totalHits).toBe(3);
    expect(result.gatedOutCount).toBe(2);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].channelId).toBe('twitter:timeline');

    const summaryPayload = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content as string;
    expect(summaryPayload).toContain('public launch announcement');
    expect(summaryPayload).not.toContain('ultra-private confidences');
    expect(summaryPayload).not.toContain('guild planning notes');
  });
});
