import { describe, expect, it, vi } from 'vitest';
import type {
  PromptLayerStatePort,
  PromptRegistryStatePort,
} from './prompt-state-port.js';
import { createPromptStatePort } from './prompt-state-port.js';

describe('createPromptStatePort', () => {
  it('exposes explicit disabled adapters instead of nullable sub-ports', () => {
    const promptState = createPromptStatePort({});

    expect(promptState.layers.count).toBe(0);
    expect(promptState.layers.getAll()).toEqual([]);
    expect(promptState.layers.getById('missing')).toBeUndefined();
    expect(promptState.layers.getByType('base' as never)).toEqual([]);
    expect(promptState.layers.getLayerHistory('layer-1')).toEqual([]);
    expect(promptState.layers.seedFromCharacterCard('system prompt')).toBe(false);
    expect(() => promptState.layers.create({
      type: 'base' as never,
      name: 'disabled',
      content: 'disabled',
    })).toThrow('Prompt layers are disabled in this runtime');

    expect(promptState.registry.list()).toEqual([]);
    expect(promptState.registry.getByKey('memory.extraction')).toBeUndefined();
    expect(promptState.registry.getPromptHistory('memory.extraction')).toEqual([]);
    expect(() => promptState.registry.getPrompt('memory.extraction' as never)).toThrow('Prompt registry is disabled in this runtime');
    expect(() => promptState.registry.update('memory.extraction', 'text', 'tester')).toThrow('Prompt registry is disabled in this runtime');
  });

  it('delegates to the supplied layer and registry stores when available', () => {
    const layerStore: PromptLayerStatePort = {
      count: 1,
      getAll: vi.fn(() => [{ id: 'layer-1' } as never]),
      getById: vi.fn(id => (id === 'layer-1' ? ({ id: 'layer-1' } as never) : undefined)),
      getByType: vi.fn(() => [{ id: 'layer-1' } as never]),
      create: vi.fn(() => ({ id: 'layer-2' } as never)),
      update: vi.fn(() => ({ id: 'layer-1' } as never)),
      reorderByLayerIds: vi.fn(() => [{ id: 'layer-1' } as never]),
      toggle: vi.fn(() => ({ id: 'layer-1' } as never)),
      delete: vi.fn(),
      getLayerHistory: vi.fn(() => []),
      rollback: vi.fn(() => ({ id: 'layer-1' } as never)),
      seedFromCharacterCard: vi.fn(() => true),
    };
    const registryStore: PromptRegistryStatePort = {
      list: vi.fn(() => [{ key: 'session.compaction.summary' } as never]),
      getByKey: vi.fn(key => (key === 'session.compaction.summary' ? ({ key: 'session.compaction.summary' } as never) : undefined)),
      getPrompt: vi.fn(() => 'prompt text'),
      update: vi.fn(() => ({ key: 'session.compaction.summary' } as never)),
      rollback: vi.fn(() => ({ key: 'session.compaction.summary' } as never)),
      getPromptHistory: vi.fn(() => []),
    };

    const promptState = createPromptStatePort({
      layers: layerStore,
      registry: registryStore,
    });

    expect(promptState.layers.count).toBe(1);
    expect(promptState.layers.getAll()).toEqual([{ id: 'layer-1' }]);
    expect(promptState.layers.getById('layer-1')).toEqual({ id: 'layer-1' });
    expect(promptState.layers.getByType('base' as never)).toEqual([{ id: 'layer-1' }]);
    expect(promptState.layers.create({
      type: 'base' as never,
      name: 'layer',
      content: 'content',
    })).toEqual({ id: 'layer-2' });
    expect(promptState.registry.list()).toEqual([{ key: 'session.compaction.summary' }]);
    expect(promptState.registry.getPrompt('session.compaction.summary' as never)).toBe('prompt text');
  });
});
