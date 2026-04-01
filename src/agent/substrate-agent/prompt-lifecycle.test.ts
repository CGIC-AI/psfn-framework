import { describe, expect, it } from 'vitest';
import {
  buildPromptContextSectionCacheability,
  captureTurnPromptSnapshot,
} from './prompt-lifecycle.js';
import type { PromptComposer } from '../../identity/prompt-composer.js';

describe('prompt-lifecycle cacheability', () => {
  it('annotates template sections with cacheability classes and breakers', () => {
    const promptComposer = {
      composeSplit: () => ({
        text: 'BASE {{user}}\n\nRUNTIME {{channel_id}}',
        hash: 'prompt-hash',
        layerCount: 2,
        layerIds: ['base-1', 'runtime-1'],
        staticPrefix: 'BASE {{user}}',
        dynamicSuffix: 'RUNTIME {{channel_id}}',
        staticHash: 'static-hash',
        dynamicHash: 'dynamic-hash',
        staticLayerIds: ['base-1'],
        dynamicLayerIds: ['runtime-1'],
      }),
    } as PromptComposer;

    const snapshot = captureTurnPromptSnapshot({
      promptComposer,
      composeContext: { channelType: 'api' },
      systemPrompt: 'fallback',
    });

    expect(snapshot.sectionCacheability).toEqual([
      expect.objectContaining({
        section: 'staticPrefixTemplate',
        cacheability: 'session_stable',
        cacheBreakers: ['prompt_layer', 'macro', 'runtime'],
      }),
      expect.objectContaining({
        section: 'dynamicSuffixTemplate',
        cacheability: 'session_stable',
        cacheBreakers: ['prompt_layer', 'runtime', 'channel', 'task', 'macro'],
      }),
    ]);
  });

  it('marks resolved prompt sections with cache breakers for runtime, retrieval, and scratchpad inputs', () => {
    const sectionCacheability = buildPromptContextSectionCacheability({
      promptSnapshot: {
        sectionCacheability: [
          {
            section: 'staticPrefixTemplate',
            cacheability: 'static',
            cacheBreakers: ['prompt_layer'],
            reason: 'Frozen base/operator prompt layers only change when the prompt stack is edited.',
          },
        ],
      },
      renderedStaticPrefix: 'Static prefix',
      renderedDynamicSuffix: 'Dynamic suffix with persona hint',
      runtimeContext: 'Runtime context block',
      memoryContextBlock: 'Retrieved memory block',
      scratchpadContext: 'Scratchpad block',
      assembledPrompt: 'Assembled prompt',
      finalSystemPrompt: 'Final system prompt',
      messageCount: 3,
    });

    expect(sectionCacheability).toEqual([
      expect.objectContaining({
        section: 'renderedStaticPrefix',
        cacheability: 'static',
        cacheBreakers: ['prompt_layer'],
      }),
      expect.objectContaining({
        section: 'renderedDynamicSuffix',
        cacheability: 'volatile',
        cacheBreakers: ['runtime', 'channel', 'task', 'macro'],
      }),
      expect.objectContaining({
        section: 'runtimeContext',
        cacheability: 'volatile',
        cacheBreakers: ['runtime', 'channel', 'tool'],
      }),
      expect.objectContaining({
        section: 'memoryContextBlock',
        cacheability: 'volatile',
        cacheBreakers: ['retrieval'],
      }),
      expect.objectContaining({
        section: 'scratchpadContext',
        cacheability: 'volatile',
        cacheBreakers: ['scratchpad'],
      }),
      expect.objectContaining({
        section: 'assembledPrompt',
        cacheability: 'volatile',
        cacheBreakers: ['runtime', 'channel', 'tool', 'scratchpad'],
      }),
      expect.objectContaining({
        section: 'finalSystemPrompt',
        cacheability: 'volatile',
        cacheBreakers: ['runtime', 'channel', 'tool', 'retrieval', 'scratchpad', 'session_history'],
      }),
      expect.objectContaining({
        section: 'messages',
        cacheability: 'append_only',
        cacheBreakers: ['session_history'],
      }),
    ]);
  });
});
