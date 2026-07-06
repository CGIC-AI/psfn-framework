import { describe, expect, it, vi } from 'vitest';
import { runSessionSearch } from './search-runtime.js';
import type { TranscriptSearchPort } from '../../persistence/sessions/transcript-search-port.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { PromptRegistryStatePort } from '../identity/prompt-state-port.js';
import { SESSION_SEARCH_SUMMARY_PROMPT_KEY, getDefaultPromptText } from '../identity/prompt-registry.js';

const PUBLIC_HIT = {
  channelId: 'api:public-session',
  messageId: 1,
  role: 'assistant',
  timestamp: 1_000,
  channelVisibility: 'public',
  score: 0.1,
  snippet: 'Project Orion launch is public.',
  content: 'Project Orion launch is public.',
} as const;

const PRIVATE_HIT = {
  channelId: 'api:private-session',
  messageId: 2,
  role: 'assistant',
  timestamp: 2_000,
  channelVisibility: 'private',
  score: 0.2,
  snippet: 'Project Orion private rollout notes.',
  content: 'Project Orion private rollout notes.',
} as const;

const PUBLIC_VIEWER = {
  channelId: 'api:public-search',
  trustLevel: 'regular',
  channelVisibility: 'public',
} as const;

function makeTranscriptSearch(hits: unknown[]): TranscriptSearchPort {
  return {
    searchByKeywords: vi.fn(() => hits),
  } as unknown as TranscriptSearchPort;
}

function makeLlmProvider(complete: ReturnType<typeof vi.fn>): LLMProviderPort {
  return { complete } as unknown as LLMProviderPort;
}

function makePromptRegistry(promptText: string): PromptRegistryStatePort {
  return {
    list: () => [],
    getByKey: () => undefined,
    getPrompt: vi.fn(() => promptText),
    update: () => {
      throw new Error('not implemented');
    },
    rollback: () => {
      throw new Error('not implemented');
    },
    getPromptHistory: () => [],
  } as unknown as PromptRegistryStatePort;
}

describe('runSessionSearch', () => {
  it('queries the transcript search port and applies visibility and channel scoping', async () => {
    const transcriptSearch = makeTranscriptSearch([PUBLIC_HIT, PRIVATE_HIT]);

    const result = await runSessionSearch({
      transcriptSearch,
      query: 'Project Orion',
      limit: 5,
      summarize: false,
      targetChannelId: 'api:public-session',
      viewer: PUBLIC_VIEWER,
    });

    expect(transcriptSearch.searchByKeywords).toHaveBeenCalledWith('Project Orion', 20);
    expect(result.totalHits).toBe(1);
    expect(result.gatedOutCount).toBe(0);
    expect(result.hits).toEqual([
      expect.objectContaining({
        channelId: 'api:public-session',
        messageId: 1,
        channelVisibility: 'public',
      }),
    ]);
    expect(result.summary).toContain('Found 1 transcript matches');
  });

  it('returns an empty search result when the transcript search port is missing', async () => {
    const result = await runSessionSearch({
      transcriptSearch: null,
      query: 'Project Orion',
      summarize: false,
    });

    expect(result.totalHits).toBe(0);
    expect(result.gatedOutCount).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.summary).toContain('No transcript matches found');
  });
});

describe('runSessionSearch summarize consolidation', () => {
  it('summarizes through the shared completion path with the registry prompt and correlation metadata', async () => {
    const complete = vi.fn(async () => ({
      content: 'Registry-backed search summary.',
      toolCalls: [],
      model: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'stop',
    }));
    const promptRegistry = makePromptRegistry('Registry-owned session search summary prompt.');

    const result = await runSessionSearch({
      transcriptSearch: makeTranscriptSearch([PUBLIC_HIT]),
      llmProvider: makeLlmProvider(complete),
      promptRegistry,
      query: 'Project Orion',
      summarize: true,
      viewer: PUBLIC_VIEWER,
    });

    expect(result.summary).toBe('Registry-backed search summary.');
    expect(promptRegistry.getPrompt).toHaveBeenCalledWith(SESSION_SEARCH_SUMMARY_PROMPT_KEY);
    expect(complete).toHaveBeenCalledTimes(1);

    const [request, positionalCallType] = complete.mock.calls[0] as [
      {
        systemPrompt: string;
        messages: Array<{ role: string; content: string }>;
        correlation: Record<string, unknown>;
      },
      string,
    ];
    // Compaction-service convention: positional callType 'background',
    // correlation callType 'summary'.
    expect(positionalCallType).toBe('background');
    expect(request.systemPrompt).toBe('Registry-owned session search summary prompt.');
    expect(request.correlation).toEqual(expect.objectContaining({
      callType: 'summary',
      purpose: 'session.search.summary',
      originType: 'summary',
      originStage: 'session.search.summary',
      channelId: 'api:public-search',
    }));
    expect(String(request.correlation.requestId)).toMatch(/^search-summary:.*:summary$/);
  });

  it('falls back to the seed prompt when no registry is provided', async () => {
    const complete = vi.fn(async () => ({
      content: 'Seed prompt summary.',
      toolCalls: [],
      model: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'stop',
    }));

    const result = await runSessionSearch({
      transcriptSearch: makeTranscriptSearch([PUBLIC_HIT]),
      llmProvider: makeLlmProvider(complete),
      query: 'Project Orion',
      summarize: true,
      viewer: PUBLIC_VIEWER,
    });

    expect(result.summary).toBe('Seed prompt summary.');
    const [request] = complete.mock.calls[0] as [{ systemPrompt: string }];
    expect(request.systemPrompt).toBe(getDefaultPromptText(SESSION_SEARCH_SUMMARY_PROMPT_KEY));
  });

  it('keeps the deterministic no-hit fallback without an LLM call', async () => {
    const complete = vi.fn(async () => ({ content: 'unused' }));

    const result = await runSessionSearch({
      transcriptSearch: makeTranscriptSearch([]),
      llmProvider: makeLlmProvider(complete),
      promptRegistry: makePromptRegistry('unused'),
      query: 'Project Orion',
      summarize: true,
      viewer: PUBLIC_VIEWER,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.summary).toBe('No transcript matches found for "Project Orion".');
    expect(result.hits).toEqual([]);
  });

  it('returns the deterministic fallback summary when the LLM call fails after retry', async () => {
    const complete = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    const result = await runSessionSearch({
      transcriptSearch: makeTranscriptSearch([PUBLIC_HIT]),
      llmProvider: makeLlmProvider(complete),
      promptRegistry: makePromptRegistry('Registry-owned session search summary prompt.'),
      query: 'Project Orion',
      summarize: true,
      viewer: PUBLIC_VIEWER,
    });

    // withRetry(maxRetries: 1) => two attempts, then non-blocking fallback.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe(
      'Found 1 transcript matches for "Project Orion" across 1 channel(s): api:public-session.',
    );
    expect(result.hits).toHaveLength(1);
  });

  it('only feeds privacy-visible hits to the summarizer payload', async () => {
    const complete = vi.fn(async () => ({
      content: 'Filtered summary.',
      toolCalls: [],
      model: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'stop',
    }));

    const result = await runSessionSearch({
      transcriptSearch: makeTranscriptSearch([PUBLIC_HIT, PRIVATE_HIT]),
      llmProvider: makeLlmProvider(complete),
      promptRegistry: makePromptRegistry('Registry-owned session search summary prompt.'),
      query: 'Project Orion',
      summarize: true,
      viewer: PUBLIC_VIEWER,
    });

    expect(result.totalHits).toBe(2);
    expect(result.gatedOutCount).toBe(1);
    const [request] = complete.mock.calls[0] as [{ messages: Array<{ content: string }> }];
    const payload = request.messages[0].content;
    expect(payload).toContain('Project Orion launch is public.');
    expect(payload).not.toContain('private rollout notes');
  });
});
