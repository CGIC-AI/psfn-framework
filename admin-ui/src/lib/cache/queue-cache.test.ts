import { describe, expect, it } from 'vitest';
import {
  isAdminConfirmationsData,
  isIntakeQuarantineListData,
  normalizeIntakeQuarantineListData,
} from './queue-cache';

function confirmation(resolutionAuthority?: unknown): unknown {
  return {
    entries: [{
      id: 'confirmation-1',
      method: 'tools.call',
      action: 'write',
      scope: 'workspace',
      params: {},
      companionReason: 'Operator approval is required.',
      requestedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
      ...(resolutionAuthority === undefined ? {} : { resolutionAuthority }),
    }],
    available: true,
  };
}

describe('queue cache validators', () => {
  it('accepts only the canonical confirmation resolution authority', () => {
    expect(isAdminConfirmationsData(confirmation())).toBe(true);
    expect(isAdminConfirmationsData(confirmation('operator'))).toBe(true);
    expect(isAdminConfirmationsData(confirmation('companion'))).toBe(false);
    expect(isAdminConfirmationsData(confirmation({ kind: 'operator' }))).toBe(false);
    expect(isAdminConfirmationsData(confirmation(null))).toBe(false);
  });

  it('accepts legacy quarantine rows without rule matches and rejects malformed new provenance', () => {
    const item = {
      id: 'env-12345678',
      status: 'held',
      mode: 'enforce',
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      originRef: 'https://example.test',
      riskLabels: ['injection/override_attempt'],
      scores: { 'l1.rules': 0.9 },
      heldAt: '2026-08-06T00:00:00.000Z',
      expiresAt: '2026-08-13T00:00:00.000Z',
      ttlRemainingMs: 1000,
      rawTextTruncated: false,
      safeRepresentationAvailable: false,
      flywheelTarget: null,
    };

    expect(isIntakeQuarantineListData({ items: [item] })).toBe(true);
    expect(isIntakeQuarantineListData({
      items: [{
        ...item,
        ruleMatches: [],
        ruleMatchTotalCount: 0,
        ruleMatchesTruncated: false,
      }],
    })).toBe(true);
    expect(isIntakeQuarantineListData({
      items: [
        item,
        {
          ...item,
          id: 'env-isolated-provenance',
          ruleMatches: [],
          ruleMatchTotalCount: 0,
          ruleMatchesTruncated: false,
          ruleMatchProvenanceUnavailable: true,
        },
      ],
    })).toBe(true);
    expect(isIntakeQuarantineListData({
      items: [{ ...item, ruleMatchProvenanceUnavailable: 'yes' }],
    })).toBe(false);
    expect(isIntakeQuarantineListData({
      items: [{
        ...item,
        ruleMatches: [{
          ruleId: 'persona_mutation_request',
          kind: 'near',
          startOffset: 12,
          endOffset: 37,
          excerpt: 'change your persona now',
        }],
        ruleMatchTotalCount: 39,
        ruleMatchesTruncated: true,
      }],
    })).toBe(true);
    expect(isIntakeQuarantineListData({
      items: [{ ...item, ruleMatches: [], ruleMatchTotalCount: 39, ruleMatchesTruncated: false }],
    })).toBe(false);
    expect(isIntakeQuarantineListData({
      items: [{
        ...item,
        ruleMatches: [{
          ruleId: 'persona_mutation_request',
          kind: 'glob',
          startOffset: 20,
          endOffset: 10,
          excerpt: 'invalid',
          rawText: 'must not pass the cache boundary',
        }],
      }],
    })).toBe(false);
    expect(isIntakeQuarantineListData({
      items: [{
        ...item,
        ruleMatches: [{
          ruleId: 'persona_mutation_request',
          kind: 'phrase',
          startOffset: 12,
          endOffset: 18,
          excerpt: `change${'\uD83D'}`,
        }],
      }],
    })).toBe(false);
    for (const separator of ['\u2028', '\u2029']) {
      expect(isIntakeQuarantineListData({
        items: [{
          ...item,
          ruleMatches: [{
            ruleId: 'persona_mutation_request',
            kind: 'phrase',
            startOffset: 12,
            endOffset: 18,
            excerpt: `change${separator}spoof`,
          }],
        }],
      })).toBe(false);
    }
    expect(isIntakeQuarantineListData({
      items: [{
        ...item,
        ruleMatches: [
          {
            ruleId: 'persona_mutation_request',
            kind: 'phrase',
            startOffset: 12,
            endOffset: 18,
            excerpt: 'change',
          },
          {
            ruleId: 'persona_mutation_request',
            kind: 'phrase',
            startOffset: 24,
            endOffset: 30,
            excerpt: 'persona',
          },
        ],
        ruleMatchTotalCount: 2,
        ruleMatchesTruncated: false,
      }],
    })).toBe(false);
  });

  it('isolates malformed optional provenance without dropping healthy cached rows', () => {
    const healthy = {
      id: 'env-healthy-cache',
      status: 'held',
      mode: 'enforce',
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      originRef: 'https://example.test',
      riskLabels: ['injection/override_attempt'],
      scores: { 'l1.rules': 0.9 },
      ruleMatches: [],
      ruleMatchTotalCount: 0,
      ruleMatchesTruncated: false,
      heldAt: '2026-08-06T00:00:00.000Z',
      expiresAt: '2026-08-13T00:00:00.000Z',
      ttlRemainingMs: 1000,
      rawTextTruncated: false,
      safeRepresentationAvailable: false,
      flywheelTarget: null,
    };
    const normalized = normalizeIntakeQuarantineListData({
      items: [
        healthy,
        {
          ...healthy,
          id: 'env-malformed-cache',
          ruleMatches: [{
            ruleId: '<unsafe-rule>',
            kind: 'glob',
            startOffset: 20,
            endOffset: 10,
            excerpt: '<script>unsafe()</script>',
            rawText: 'must not survive normalization',
          }],
          ruleMatchTotalCount: 'many',
          ruleMatchesTruncated: true,
        },
      ],
    });

    expect(isIntakeQuarantineListData(normalized)).toBe(true);
    expect(normalized).toMatchObject({
      items: [
        { id: healthy.id },
        {
          id: 'env-malformed-cache',
          ruleMatches: [],
          ruleMatchTotalCount: 0,
          ruleMatchesTruncated: false,
          ruleMatchProvenanceUnavailable: true,
        },
      ],
    });
    expect((normalized as { items: unknown[] }).items[0])
      .not.toHaveProperty('ruleMatchProvenanceUnavailable');
    expect(JSON.stringify(normalized)).not.toContain('unsafe');
    expect(JSON.stringify(normalized)).not.toContain('must not survive');
  });
});
