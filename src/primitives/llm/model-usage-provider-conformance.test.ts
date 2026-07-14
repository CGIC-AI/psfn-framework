import { describe, expect, it } from 'vitest';

import { loadModelUsageCertificationFixture } from '../../test-support/model-usage-certification-fixtures.js';
import { normalizeLLMUsageDetails } from './client-response-helpers.js';

describe('model usage provider conformance corpus', () => {
  const fixture = loadModelUsageCertificationFixture();

  it('pins provenance and enumerates every certification requirement as MUST', () => {
    expect(fixture.provenance).toMatchObject({
      kind: 'synthetic-spec-derived',
      frozenAtCommit: 'e8ded0b4',
      reviewCommand: 'npm run verify:accounting-certification',
    });
    expect(fixture.provenance.generation).toContain('no provider request');
    expect(new Set(fixture.requirements.map(requirement => requirement.id)).size)
      .toBe(fixture.requirements.length);
    expect(fixture.requirements.map(requirement => requirement.level))
      .toEqual(Array.from({ length: fixture.requirements.length }, () => 'MUST'));
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.providerCases[0]?.rawUsage)).toBe(true);
  });

  it('normalizes immutable OpenAI-compatible, OpenRouter, LiteLLM, and local shapes exactly', () => {
    expect(new Set(fixture.providerCases.map(entry => entry.route))).toEqual(new Set([
      'openai_compatible',
      'openrouter',
      'litellm_proxy',
      'local',
    ]));
    for (const providerCase of fixture.providerCases) {
      const actual = normalizeLLMUsageDetails(
        providerCase.rawUsage,
        providerCase.fallbackInputTokens,
        providerCase.fallbackOutputTokens,
      );
      expect(actual, providerCase.id).toMatchObject(providerCase.expected);
    }
  });

  it('fails closed on malformed counts/shapes and quarantines malformed cost evidence', () => {
    for (const invalidCase of fixture.invalidProviderCases) {
      if (invalidCase.expectedError) {
        expect(
          () => normalizeLLMUsageDetails(invalidCase.rawUsage, 0, 0),
          invalidCase.id,
        ).toThrow(invalidCase.expectedError);
        continue;
      }

      const actual = normalizeLLMUsageDetails(invalidCase.rawUsage, 0, 0);
      expect(actual, invalidCase.id).toMatchObject({
        ...invalidCase.expected,
        costEvidenceConflict: invalidCase.expectedConflict,
      });
      expect(actual.cost?.total, invalidCase.id).toBeUndefined();
    }
  });
});
