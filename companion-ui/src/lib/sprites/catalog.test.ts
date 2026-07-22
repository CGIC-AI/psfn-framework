import { describe, expect, it } from 'vitest';
import type { SpriteState } from '../../ui/types.js';
import { buildSpriteManifest } from './manifest.js';
import { resolveSpriteEntryId } from './catalog.js';

const ALL_STATES: SpriteState[] = ['attentive', 'speaking', 'listening', 'thinking', 'tool_use', 'error'];
const manifest = buildSpriteManifest();

describe('resolveSpriteEntryId', () => {
  it('maps every operational SpriteState to an entry the manifest contains', () => {
    for (const state of ALL_STATES) {
      const id = resolveSpriteEntryId({ state });
      expect(manifest.entries[id], `state ${state} -> ${id}`).toBeDefined();
    }
  });

  it('resolves every base x crop pairing to an existing entry', () => {
    for (const crop of ['mini', 'avatar'] as const) {
      const id = resolveSpriteEntryId({ state: 'attentive', crop });
      expect(manifest.entries[id]?.crop).toBe(crop);
    }
  });

  it('prioritises touch over tool and emotional base', () => {
    const id = resolveSpriteEntryId({
      state: 'tool_use',
      touch: 'headpat-happy',
      toolDomain: 'notebook',
      base: 'love',
    });
    expect(id).toBe('touch.headpat-happy');
    expect(manifest.entries[id]?.kind).toBe('touch');
  });

  it('prioritises an explicit tool domain over the emotional base', () => {
    const id = resolveSpriteEntryId({ state: 'attentive', toolDomain: 'painting', toolPhase: 'completed' });
    expect(id).toBe('tool.painting.completed');
    expect(manifest.entries[id]).toBeDefined();
  });

  it('renders the tool_use state as the default wrench loop until tool-domain lands', () => {
    const id = resolveSpriteEntryId({ state: 'tool_use' });
    expect(id).toBe('tool.wrench.started');
    expect(manifest.entries[id]?.loop).toBe(true);
  });

  it('honours an explicit emotional base and falls back for an unknown one', () => {
    expect(resolveSpriteEntryId({ state: 'attentive', base: 'excited' })).toBe('expr.excited.mini');
    // Unknown base -> per-state fallback (attentive -> neutral).
    const bogus = resolveSpriteEntryId({ state: 'attentive', base: 'nonsense' as never });
    expect(bogus).toBe('expr.neutral.mini');
    expect(manifest.entries[bogus]).toBeDefined();
  });

  it('uses distinct emotional bases per operational state', () => {
    const ids = ALL_STATES.filter((s) => s !== 'tool_use').map((state) => resolveSpriteEntryId({ state }));
    // attentive/speaking/listening/thinking/error all differ.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
