import { describe, expect, it } from 'vitest';
import { getLatestAssistantMessage, resolveContextWindow } from './agent-state-runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    modelRoster: {
      chat: {
        model: 'chat-model',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 16_384,
      },
    },
    defaultContextWindow: 16_384,
    ...overrides,
  } as unknown as SubstrateConfig;
}

describe('resolveContextWindow', () => {
  it('prefers the configured chat slot context window', () => {
    expect(resolveContextWindow(makeConfig(), undefined)).toBe(16_384);
  });

  it('uses the runtime model context window when config is missing', () => {
    expect(resolveContextWindow(
      makeConfig({
        modelRoster: { chat: { model: 'chat-model', provider: 'openrouter', maxTokens: 4096 } },
        defaultContextWindow: 0,
      }),
      { contextWindow: 32_768 },
    )).toBe(32_768);
  });

  it('fails closed when no positive context window is available', () => {
    expect(() => resolveContextWindow(
      makeConfig({
        modelRoster: { chat: { model: 'chat-model', provider: 'openrouter', maxTokens: 4096 } },
        defaultContextWindow: 0,
      }),
      undefined,
    )).toThrow('No positive context window is configured for the active chat model.');
  });
});

describe('getLatestAssistantMessage', () => {
  const assistant = (text: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  });
  const messages = [
    { role: 'user', content: 'hello' },
    assistant('user-facing reply'),
    { role: 'custom', type: 'internalWhisper', content: 'note to self' },
    assistant('internal continuation'),
  ];

  it('returns the last assistant message when unbounded', () => {
    expect(getLatestAssistantMessage(messages)?.content)
      .toEqual([{ type: 'text', text: 'internal continuation' }]);
  });

  it('excludes assistant messages at or past the user-facing boundary', () => {
    expect(getLatestAssistantMessage(messages, 2)?.content)
      .toEqual([{ type: 'text', text: 'user-facing reply' }]);
  });

  it('returns null when no assistant message exists before the boundary', () => {
    expect(getLatestAssistantMessage(messages, 1)).toBeNull();
  });

  it('ignores invalid boundary values', () => {
    expect(getLatestAssistantMessage(messages, -1)?.content)
      .toEqual([{ type: 'text', text: 'internal continuation' }]);
    expect(getLatestAssistantMessage(messages, Number.NaN)?.content)
      .toEqual([{ type: 'text', text: 'internal continuation' }]);
    expect(getLatestAssistantMessage(messages, 99)?.content)
      .toEqual([{ type: 'text', text: 'internal continuation' }]);
  });
});
