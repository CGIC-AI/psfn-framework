import { describe, expect, it } from 'vitest';
import { resolveProfileConfig } from './config.js';

describe('resolveProfileConfig', () => {
  it('clamps sourceMemoryLimit to at least minSourceMemories', () => {
    const resolved = resolveProfileConfig({
      profileSynthesisSourceMemoryLimit: 16,
      profileSynthesisMinSourceMemories: 20,
    } as any);

    expect(resolved.minSourceMemories).toBe(20);
    expect(resolved.sourceMemoryLimit).toBe(20);
  });
});
