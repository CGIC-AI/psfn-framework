import { describe, expect, it } from 'vitest';
import {
  parsePrivacyBreakGlassConfirmRequest,
  PRIVACY_BREAK_GLASS_REASON_CATEGORIES,
} from './privacy-break-glass.js';

describe('privacy break-glass reason categories', () => {
  it('supports ordinary research checks without retaining the legal-emergency category', () => {
    expect(PRIVACY_BREAK_GLASS_REASON_CATEGORIES).toContain('research_check');
    expect(PRIVACY_BREAK_GLASS_REASON_CATEGORIES).not.toContain('legal_emergency' as never);
    expect(parsePrivacyBreakGlassConfirmRequest({
      reasonCategory: 'research_check',
      reason: 'Review journal quality and grounding.',
    })).toEqual({
      reasonCategory: 'research_check',
      reason: 'Review journal quality and grounding.',
    });
    expect(() => parsePrivacyBreakGlassConfirmRequest({
      reasonCategory: 'legal_emergency',
      reason: 'Legacy category must reject.',
    })).toThrow(/reasonCategory is invalid/u);
  });
});
