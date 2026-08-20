import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel } from '$lib/types';
import DiscoveredModelsPanel from './DiscoveredModelsPanel.svelte';
import EffectiveChatModelView from './EffectiveChatModelView.svelte';

function discovered(id: string): DiscoveredModel {
  return {
    id,
    supportsVision: false,
    supportsReasoning: false,
    zdrAvailable: false,
  };
}

describe('compact Models controls', () => {
  it('bounds discovery to a keyboard-scrollable two-row surface while retaining every result', () => {
    const models = Array.from({ length: 9 }, (_, index) => discovered(`provider/model-${index}`));
    const body = render(DiscoveredModelsPanel, {
      props: {
        discoveryError: '',
        discoverySearch: '',
        filteredDiscoveredModels: models,
        hasDiscoveredModels: true,
        setDiscoverySearch: vi.fn(),
        addDiscoveredModel: vi.fn(),
      },
    }).body;

    expect(body).toContain('aria-label="Discovered model results"');
    expect(body).toContain('tabindex="0"');
    expect(body).toContain('grid-rows-2');
    expect(body).toContain('overflow-x-auto');
    for (const model of models) expect(body).toContain(model.id);
  });

  it('keeps effective configuration while removing redundant runtime-truth prose', () => {
    const body = render(EffectiveChatModelView, {
      props: {
        effectiveChat: {
          purpose: 'chat',
          source: 'companion_selection',
          slotKey: 'chat-primary',
          provider: 'openrouter',
          model: 'provider/model',
        },
        fleetDefault: null,
        loading: false,
        loadError: '',
      },
    }).body;

    expect(body).toContain('Effective chat model');
    expect(body).toContain('provider/model');
    expect(body).not.toContain('Runtime truth');
  });
});
