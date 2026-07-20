import { describe, expect, it } from 'vitest';
import { describeConcernEmotionalArc } from './concern-arc-prose.js';

describe('describeConcernEmotionalArc', () => {
  it('renders both halves of the arc as prose without raw numbers', () => {
    const prose = describeConcernEmotionalArc({
      formationVAD: { valence: -0.4, arousal: 0.6, dominance: -0.3 },
      resolutionVAD: { valence: 0.4, arousal: -0.3, dominance: 0.3 },
    });
    expect(prose).toBeDefined();
    // Formation prose (heavy / activated / less agentic) then resolution prose.
    expect(prose).toContain('heavy');
    expect(prose).toContain('activated');
    expect(prose).toContain('less agentic');
    expect(prose).toContain('resolving it, that settled to');
    expect(prose).toContain('lifted');
    expect(prose).toContain('quieted');
    expect(prose).toContain('agentic');
    // Charter 8.6: no score wall — no raw VAD magnitudes in the prose.
    expect(prose).not.toMatch(/-?0\.\d/);
  });

  it('surfaces only the formation half when resolution was not captured (no fabrication)', () => {
    const prose = describeConcernEmotionalArc({
      formationVAD: { valence: -0.4, arousal: 0.6, dominance: -0.3 },
    });
    expect(prose).toBe('When it formed this sat heavy, activated, and less agentic.');
    expect(prose).not.toContain('resolving it');
  });

  it('surfaces only the resolution half when formation was not captured', () => {
    const prose = describeConcernEmotionalArc({
      resolutionVAD: { valence: 0.4, arousal: -0.3, dominance: 0.3 },
    });
    expect(prose).toBe('Resolving it, it felt lifted, quieted, and agentic.');
    expect(prose).not.toContain('When it formed');
  });

  it('returns undefined when neither half exists', () => {
    expect(describeConcernEmotionalArc({})).toBeUndefined();
  });
});
