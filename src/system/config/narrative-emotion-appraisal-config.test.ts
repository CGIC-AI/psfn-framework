import { describe, expect, it } from 'vitest';

import {
  createDefaultNarrativeEmotionAppraisalSettings,
  normalizeNarrativeEmotionAppraisalSettings,
} from './narrative-emotion-appraisal-config.js';

describe('narrative emotion appraisal settings', () => {
  it('defaults production narrative appraisal to drift-only', () => {
    expect(createDefaultNarrativeEmotionAppraisalSettings()).toEqual({
      mode: 'drift_only',
      vadDeltaThreshold: 0.35,
    });
  });

  it('normalizes operator-owned mode and threshold and rejects unknown policy', () => {
    expect(normalizeNarrativeEmotionAppraisalSettings({
      mode: 'disabled',
      vadDeltaThreshold: 0.5,
    })).toEqual({
      mode: 'disabled',
      vadDeltaThreshold: 0.5,
    });
    expect(() => normalizeNarrativeEmotionAppraisalSettings({ mode: 'periodic' }))
      .toThrow(/mode/);
    expect(() => normalizeNarrativeEmotionAppraisalSettings({
      mode: 'drift_only',
      vadDeltaThreshold: 0,
    })).toThrow(/vadDeltaThreshold/);
  });
});
