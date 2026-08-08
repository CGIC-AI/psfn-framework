import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { resolveProfileConfig } from './config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

describe('resolveProfileConfig', () => {
  it('clamps sourceMemoryLimit to at least minSourceMemories', () => {
    const resolved = resolveProfileConfig(fromPartial<SubstrateConfig>({
      profileSynthesisSourceMemoryLimit: 16,
      profileSynthesisMinSourceMemories: 20,
    }));

    expect(resolved.minSourceMemories).toBe(20);
    expect(resolved.sourceMemoryLimit).toBe(20);
  });
});
