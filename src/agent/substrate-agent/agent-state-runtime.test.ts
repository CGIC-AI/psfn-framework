import { describe, expect, it } from 'vitest';
import { resolveContextWindow } from './agent-state-runtime.js';
import type { SubstrateConfig } from '../../types.js';

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
