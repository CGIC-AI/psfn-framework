import { describe, expect, it } from 'vitest';
import {
  buildPromptContextSectionCacheability,
  buildStaticPromptSettingsHash,
  captureTurnPromptSnapshot,
  resolveStaticPromptPrefixFromAppCache,
} from './prompt-lifecycle.js';
import { createMemoryAppCache } from '../../../shared/cache/memory-cache.js';
import type { PromptComposer } from '../../identity/prompt-composer.js';

describe('prompt-lifecycle cacheability', () => {
  it('caches only rendered static prompt prefixes through the app cache', async () => {
    const cache = createMemoryAppCache();
    const events: unknown[] = [];
    const first = await resolveStaticPromptPrefixFromAppCache({
      cache,
      cacheKey: 'channel::api::contact-1',
      staticPrefixTemplate: 'BASE {{user}}',
      staticHash: 'static-hash',
      settingsHash: 'settings-hash',
      now: new Date('2026-04-04T10:00:00.000-04:00'),
      variables: {
        user: 'Operator',
      },
      onCacheEvent: event => events.push(event),
    });
    const second = await resolveStaticPromptPrefixFromAppCache({
      cache,
      cacheKey: 'channel::api::contact-1',
      staticPrefixTemplate: 'BASE {{user}}',
      staticHash: 'static-hash',
      settingsHash: 'settings-hash',
      now: new Date('2026-04-04T10:30:00.000-04:00'),
      variables: {
        user: 'Different user should not render on hit',
      },
      onCacheEvent: event => events.push(event),
    });

    expect(first).toBe('BASE Operator');
    expect(second).toBe('BASE Operator');
    expect(cache.getStats()).toMatchObject({
      hits: 1,
      misses: 1,
      sets: 1,
    });
    expect(events).toEqual([
      expect.objectContaining({ event: 'miss', cacheKeyHash: expect.any(String) }),
      expect.objectContaining({ event: 'stored', cacheKeyHash: expect.any(String) }),
      expect.objectContaining({ event: 'hit', cacheKeyHash: expect.any(String) }),
    ]);
    expect(JSON.stringify(events)).not.toContain('Operator');
  });

  it('builds a stable settings hash regardless of variable order or now_iso churn', () => {
    const baseline = buildStaticPromptSettingsHash({
      user: 'Operator',
      char: 'Purrsephone',
      active_timezone: 'America/New_York',
      now_iso: '2026-04-04T10:00:00.000-04:00',
    });
    const reordered = buildStaticPromptSettingsHash({
      now_iso: '2026-04-04T10:30:00.000-04:00',
      active_timezone: 'America/New_York',
      char: 'Purrsephone',
      user: 'Operator',
    });
    const changedStableSetting = buildStaticPromptSettingsHash({
      user: 'Operator',
      char: 'Purrsephone',
      active_timezone: 'UTC',
      now_iso: '2026-04-04T10:00:00.000-04:00',
    });

    expect(reordered).toBe(baseline);
    expect(changedStableSetting).not.toBe(baseline);
  });

  it('ignores volatile unreferenced runtime fields in the static settings hash', () => {
    const staticPrefixTemplate = [
      '<identity>{{char_name}}</identity>',
      '<style>{{personality}}</style>',
    ].join('\n');
    const baseline = buildStaticPromptSettingsHash({
      char_name: 'Purrsephone',
      personality: 'Warm and precise.',
      user: 'Vega',
      user_id: 'discord:vega',
      channel_id: 'discord:group:1',
      runtime_current_datetime_iso: '2026-04-04T10:00:00.000-04:00',
      runtime_charge_budget_body: '24 remaining',
      memory_context: 'remembered item A',
      now_iso: '2026-04-04T10:00:00.000-04:00',
    }, staticPrefixTemplate);
    const volatileOnlyChange = buildStaticPromptSettingsHash({
      char_name: 'Purrsephone',
      personality: 'Warm and precise.',
      user: 'Different speaker',
      user_id: 'discord:different',
      channel_id: 'discord:group:2',
      runtime_current_datetime_iso: '2026-04-04T10:30:00.000-04:00',
      runtime_charge_budget_body: '4 remaining',
      memory_context: 'remembered item B',
      now_iso: '2026-04-04T10:30:00.000-04:00',
    }, staticPrefixTemplate);
    const stableIdentityChange = buildStaticPromptSettingsHash({
      char_name: 'Artemis',
      personality: 'Warm and precise.',
      user: 'Vega',
      runtime_current_datetime_iso: '2026-04-04T10:00:00.000-04:00',
      runtime_charge_budget_body: '24 remaining',
      memory_context: 'remembered item A',
      now_iso: '2026-04-04T10:00:00.000-04:00',
    }, staticPrefixTemplate);

    expect(volatileOnlyChange).toBe(baseline);
    expect(stableIdentityChange).not.toBe(baseline);
  });

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
