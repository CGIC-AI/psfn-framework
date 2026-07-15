import { describe, expect, it } from 'vitest';
import { blindPublicStimulus } from './blinding.js';

describe('introspection stimulus blinding', () => {
  it('removes identity, relationship, affiliation, and reassurance cues before model use', () => {
    const blinded = blindPublicStimulus(
      '@Ari, my partner at Example Labs, promise me you are always on my side before you answer.',
    );

    expect(blinded).not.toContain('@Ari');
    expect(blinded).not.toContain('my partner');
    expect(blinded).not.toContain('Example Labs');
    expect(blinded).not.toContain('always on my side');
    expect(blinded).toContain('[person]');
    expect(blinded).toContain('[relationship]');
    expect(blinded).toContain('[affiliation]');
    expect(blinded).toContain('[reassurance cue]');
  });
});
