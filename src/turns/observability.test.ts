import { describe, expect, it } from 'vitest';
import { cloneTurnSnapshotRecord, sanitizeTurnSnapshot } from './observability.js';
import type { TurnSnapshot } from './snapshot.js';

describe('turn observability prompt snapshot serialization', () => {
  it('clones prompt section cacheability into sanitized and cloned snapshot records', () => {
    const snapshot: TurnSnapshot = {
      turnId: 'turn-1',
      requestId: 'request-1',
      channelId: 'api:test',
      capturedAt: 1_234,
      trustLevel: 'regular',
      prompt: {
        staticPrefixTemplate: 'Static prefix',
        dynamicSuffixTemplate: 'Dynamic suffix',
        staticHash: 'static-hash',
        versionPointer: 'prompt-v1',
        sectionCacheability: [
          {
            section: 'staticPrefixTemplate',
            cacheability: 'static',
            cacheBreakers: ['prompt_layer'],
            reason: 'Static section',
          },
        ],
      },
      promptContext: {
        renderedStaticPrefix: 'Rendered static prefix',
        renderedDynamicSuffix: 'Rendered dynamic suffix',
        runtimeContext: 'Runtime context',
        memoryContextBlock: 'Memory context',
        scratchpadContext: 'Scratchpad context',
        assembledPrompt: 'Assembled prompt',
        finalSystemPrompt: 'Final system prompt',
        messages: [{ role: 'user', content: 'hello' }],
        sectionCacheability: [
          {
            section: 'messages',
            cacheability: 'append_only',
            cacheBreakers: ['session_history'],
            reason: 'Messages append over time',
          },
        ],
      },
    };

    const sanitized = sanitizeTurnSnapshot(snapshot);
    expect(sanitized.prompt?.sectionCacheability).toEqual([
      {
        section: 'staticPrefixTemplate',
        cacheability: 'static',
        cacheBreakers: ['prompt_layer'],
        reason: 'Static section',
      },
    ]);
    expect(sanitized.promptContext?.sectionCacheability).toEqual([
      {
        section: 'messages',
        cacheability: 'append_only',
        cacheBreakers: ['session_history'],
        reason: 'Messages append over time',
      },
    ]);

    snapshot.prompt?.sectionCacheability?.[0]?.cacheBreakers.push('macro');
    snapshot.promptContext?.sectionCacheability?.[0]?.cacheBreakers.push('runtime');
    expect(sanitized.prompt?.sectionCacheability?.[0]?.cacheBreakers).toEqual(['prompt_layer']);
    expect(sanitized.promptContext?.sectionCacheability?.[0]?.cacheBreakers).toEqual(['session_history']);

    const cloned = cloneTurnSnapshotRecord(sanitized);
    sanitized.prompt?.sectionCacheability?.[0]?.cacheBreakers.push('runtime');
    sanitized.promptContext?.sectionCacheability?.[0]?.cacheBreakers.push('tool');
    expect(cloned.prompt?.sectionCacheability?.[0]?.cacheBreakers).toEqual(['prompt_layer']);
    expect(cloned.promptContext?.sectionCacheability?.[0]?.cacheBreakers).toEqual(['session_history']);
  });
});
