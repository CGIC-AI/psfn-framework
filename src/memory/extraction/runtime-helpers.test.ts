import { describe, expect, it, vi } from 'vitest';
import { evaluateExtractionTrigger, resetLastExtractionCount } from './runtime-helpers.js';

const { countMessageTokens } = vi.hoisted(() => ({
  countMessageTokens: vi.fn(() => 101),
}));

vi.mock('../../llm/tokens.js', () => ({
  countMessageTokens,
}));

describe('evaluateExtractionTrigger', () => {
  it('preserves system and tool roles when counting trigger tokens', () => {
    resetLastExtractionCount();
    countMessageTokens.mockClear();

    const trigger = evaluateExtractionTrigger(
      'api:test',
      {
        getMessageCount: () => 2,
        getRecentMessages: () => [
          { role: 'system', content: 'Agent performed self-check.' },
          { role: 'tool', content: '[Tool result: search_logs] Found 3 matching log entries.' },
          { role: 'user', content: 'Please summarize the findings.' },
        ],
      } as never,
      {
        extractionInterval: 10,
        extractionThresholdPct: 50,
        defaultContextWindow: 200,
        modelRoster: {
          chat: {
            contextWindow: 200,
          },
        },
      } as never,
      10,
    );

    expect(trigger).not.toBeNull();
    expect(countMessageTokens).toHaveBeenCalledTimes(1);
    expect(countMessageTokens).toHaveBeenCalledWith([
      { role: 'system', content: 'Agent performed self-check.' },
      { role: 'tool', content: '[Tool result: search_logs] Found 3 matching log entries.' },
      { role: 'user', content: 'Please summarize the findings.' },
    ]);
  });
});
