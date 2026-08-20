import { describe, expect, it } from 'vitest';
import type { CanonicalProviderRegistry } from '$lib/types';
import type { ModelRegistryEntry } from '$lib/models/registry';
import { derivePurposeRoutingCoverage } from './routing-coverage';

const providers: CanonicalProviderRegistry = {
  schemaVersion: 1,
  providers: [
    { id: 'ready', type: 'openrouter', enabled: true },
    { id: 'off', type: 'openai', enabled: false },
  ],
};

function model(id: string, provider: string, purpose: 'chat' | 'memory'): ModelRegistryEntry {
  return {
    id,
    rank: 10,
    identity: { provider, model: `${provider}/model`, source: { type: 'openrouter' } },
    purposes: [{ purpose, primary: true }],
  };
}

describe('derivePurposeRoutingCoverage', () => {
  it('identifies healthy, missing, conflicting, and provider-disabled routes with actions', () => {
    const coverage = derivePurposeRoutingCoverage([
      model('chat', 'ready', 'chat'),
      model('memory-a', 'off', 'memory'),
    ], providers);

    expect(coverage.find(item => item.purpose === 'chat')).toMatchObject({
      status: 'ready',
      actionHref: '#selected-model-detail',
    });
    expect(coverage.find(item => item.purpose === 'memory')).toMatchObject({
      status: 'provider_disabled',
      actionHref: '#models-providers',
    });
    expect(coverage.find(item => item.purpose === 'vision')).toMatchObject({
      status: 'missing_primary',
      actionHref: '#models-registry',
    });
  });

  it('calls multiple enabled primaries a conflict rather than healthy coverage', () => {
    const coverage = derivePurposeRoutingCoverage([
      model('chat-a', 'ready', 'chat'),
      model('chat-b', 'ready', 'chat'),
    ], providers);

    expect(coverage.find(item => item.purpose === 'chat')).toMatchObject({
      status: 'conflicting_primaries',
      primaryCount: 2,
      actionHref: '#models-registry',
    });
  });
});
