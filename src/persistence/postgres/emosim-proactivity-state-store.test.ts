import { describe, expect, it } from 'vitest';

import { parseLegacyEmoSimProactivityState } from './emosim-proactivity-state-store.js';

describe('EmoSim proactivity backward state read', () => {
  it('reads only the content-free crossing cursor from the old eval state shape', () => {
    expect(parseLegacyEmoSimProactivityState({
      firstCrossingMs: 1_780_000_000_000,
      lastFiredAtMs: null,
      lastEvaluation: {
        status: 'fired',
        notes: ['fallible eval annotation'],
      },
    })).toEqual({
      firstCrossingMs: 1_780_000_000_000,
      lastFiredAtMs: null,
      lastSampledAtMs: null,
      lastInputId: null,
    });
  });

  it('fails closed on malformed legacy cursor data', () => {
    expect(() => parseLegacyEmoSimProactivityState({
      firstCrossingMs: 'yesterday',
      lastFiredAtMs: null,
    })).toThrow('firstCrossingMs');
  });
});
