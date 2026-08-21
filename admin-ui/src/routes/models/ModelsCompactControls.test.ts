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
  it('mounts a bounded accessible window in the keyboard-scrollable two-row discovery surface', () => {
    const models = Array.from(
      { length: 100 },
      (_, index) => discovered(`provider/model-${String(index).padStart(3, '0')}`),
    );
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
    expect(body).toContain('id="discovered-model-search"');
    expect(body).toContain('role="list"');
    expect(body).toContain('role="listitem"');
    expect(body).toContain('aria-setsize="100"');
    expect(body).toContain('aria-posinset="1"');
    expect(body).toContain('aria-posinset="6"');
    expect(body).toContain('provider/model-005');
    expect(body).not.toContain('provider/model-006');
    expect(body).not.toContain('provider/model-099');
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
