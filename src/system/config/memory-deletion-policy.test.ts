import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeMemoryDeletionPolicy,
  resolveMemoryDeletionJustification,
} from './memory-deletion-policy.js';

describe('memory deletion justification policy', () => {
  it('loads the canonical category set from the settings.json seed', () => {
    const seed = JSON.parse(readFileSync('config/settings.seed.json', 'utf8')) as {
      memoryDeletionPolicy?: unknown;
    };

    const policy = normalizeMemoryDeletionPolicy(seed.memoryDeletionPolicy);
    expect(policy.justificationCategories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'factually_incorrect', eligible: true }),
      expect.objectContaining({ id: 'privacy_or_consent', eligible: true }),
      expect.objectContaining({
        id: 'negative_valence_only',
        eligible: false,
        refusalReason: expect.stringMatching(/dislike.*embarrassment.*discomfort.*negative valence alone/iu),
      }),
    ]));
  });

  it('rejects duplicate categories and ineligible categories without an explicit reason', () => {
    expect(() => normalizeMemoryDeletionPolicy({
      justificationCategories: [
        { id: 'duplicate', label: 'One', eligible: true, explanationPatterns: ['duplicate'] },
        { id: 'duplicate', label: 'Two', eligible: true, explanationPatterns: ['superseded'] },
      ],
    })).toThrow(/duplicate id/iu);

    expect(() => normalizeMemoryDeletionPolicy({
      justificationCategories: [
        {
          id: 'negative_valence_only',
          label: 'Negative valence alone',
          eligible: false,
          explanationPatterns: ['dislike'],
        },
      ],
    })).toThrow(/refusalReason is required/iu);
  });

  it('fails closed when settings are absent or a category is unknown', () => {
    expect(() => resolveMemoryDeletionJustification(undefined, 'factually_incorrect', 'Source correction.'))
      .toThrow(/not configured in settings\.json/iu);
    expect(() => resolveMemoryDeletionJustification({
      justificationCategories: [
        {
          id: 'factually_incorrect',
          label: 'Factually incorrect',
          eligible: true,
          explanationPatterns: ['factually incorrect'],
        },
      ],
    }, 'invented_category', 'Some explanation.')).toThrow(/unknown memory deletion justification category/iu);
  });

  it('rejects a negative-valence-only explanation mislabeled as an eligible category', () => {
    const policy = normalizeMemoryDeletionPolicy({
      justificationCategories: [
        {
          id: 'factually_incorrect',
          label: 'Factually incorrect',
          eligible: true,
          explanationPatterns: ['factually incorrect', 'source retracted'],
        },
        {
          id: 'negative_valence_only',
          label: 'Negative valence alone',
          eligible: false,
          explanationPatterns: ['dislike', 'embarrassed', 'discomfort'],
          refusalReason: 'Dislike, embarrassment, discomfort, or negative valence alone are insufficient grounds.',
        },
      ],
    });

    expect(() => resolveMemoryDeletionJustification(
      policy,
      'factually_incorrect',
      'I dislike this and feel embarrassed by it.',
    )).toThrow(/dislike.*embarrassment.*discomfort.*negative valence alone/iu);
  });
});
