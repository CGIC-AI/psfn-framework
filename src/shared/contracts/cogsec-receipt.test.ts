import { describe, expect, it } from 'vitest';

import {
  COGSEC_INTAKE_FIREWALL_ISSUER_ID,
  cogSecContentSha256,
  cogSecPolicyDigest,
  cogSecScreeningContractDigest,
  createCogSecReceipt,
  validateCogSecReceipt,
  type CogSecReceipt,
  type CogSecScreeningContractInput,
} from './cogsec-receipt.js';

const CONTRACT: CogSecScreeningContractInput = {
  policyDigest: cogSecPolicyDigest({ mode: 'boundary', tiers: { web_fetch: 'untrusted' } }),
  ruleFingerprint: '17000000000000000:4096:12345',
  globalMode: 'boundary',
  posture: 'enforce',
  cogsecVector: 'boundary_external',
  sourceClass: 'web_fetch',
  sourceRiskTier: 'untrusted',
  scanScope: 'context',
  scannerIds: ['intake-rule-engine', 'url-scanner'],
  semanticLayers: { l2: 'not_run', l3: 'not_run' },
};

function receipt(overrides: Partial<Parameters<typeof createCogSecReceipt>[0]> = {}): CogSecReceipt {
  return createCogSecReceipt({
    receiptId: '5c3d0f6e-0000-4000-8000-000000000001',
    issuer: { id: COGSEC_INTAKE_FIREWALL_ISSUER_ID, instance: 'agent:intake-screening' },
    issuedAtMs: 1_000_000,
    expiresAtMs: 2_000_000,
    admittedContent: 'the tram was on time',
    rawContent: 'the tram was on time',
    screeningContractDigest: cogSecScreeningContractDigest(CONTRACT),
    verdict: {
      envelopeId: 'envelope-00000001',
      action: 'pass',
      state: 'released',
      posture: 'enforce',
      globalMode: 'boundary',
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      decidedAtMs: 999_999,
      riskLabels: [],
    },
    lineage: [{
      stage: 'raw_intake',
      outputSha256: cogSecContentSha256('the tram was on time'),
      transformId: 'intake',
    }],
    ...overrides,
  });
}

describe('CogSec receipt contract', () => {
  it('binds the exact admitted bytes and round-trips through fail-closed validation', () => {
    const minted = receipt();
    expect(minted.contentSha256).toBe(cogSecContentSha256('the tram was on time'));
    expect(minted.contentSizeBytes).toBe(20);
    expect(validateCogSecReceipt(JSON.parse(JSON.stringify(minted)))).toEqual(minted);
  });

  it('records the sanitize transform output as its own lineage hop', () => {
    const sanitized = receipt({
      admittedContent: 'sanitized note',
      rawContent: 'raw​note',
      lineage: [
        { stage: 'raw_intake', outputSha256: cogSecContentSha256('raw​note'), transformId: 'intake' },
        {
          stage: 'l1_sanitize',
          outputSha256: cogSecContentSha256('sanitized note'),
          transformId: 'intake-l1-sanitize',
        },
      ],
    });
    expect(sanitized.rawContentSha256).toBe(cogSecContentSha256('raw​note'));
    expect(sanitized.contentSha256).toBe(cogSecContentSha256('sanitized note'));
    expect(sanitized.rawContentSha256).not.toBe(sanitized.contentSha256);
  });

  it('carries an isolation derivation hop back to its parent receipt', () => {
    const derived = receipt({
      lineage: [
        { stage: 'raw_intake', outputSha256: cogSecContentSha256('x'), transformId: 'intake' },
        {
          stage: 'extraction',
          outputSha256: cogSecContentSha256('the tram was on time'),
          transformId: 'isolation-worker',
          parentReceiptId: '5c3d0f6e-0000-4000-8000-000000000000',
        },
      ],
    });
    expect(validateCogSecReceipt(derived).lineage[1]).toMatchObject({
      stage: 'extraction',
      parentReceiptId: '5c3d0f6e-0000-4000-8000-000000000000',
    });
  });

  it('rejects a receipt whose fields were edited after issuance', () => {
    const tampered = { ...receipt(), expiresAtMs: 9_000_000 };
    expect(() => validateCogSecReceipt(tampered))
      .toThrow(/digest does not bind its fields/);
  });

  it('refuses to mint a receipt that never expires or that certifies a withheld action', () => {
    expect(() => receipt({ expiresAtMs: 1_000_000 }))
      .toThrow(/expiresAtMs must be after issuedAtMs/);
    expect(() => receipt({ lineage: [] })).toThrow(/lineage must record/);
    expect(() => validateCogSecReceipt({
      ...receipt(),
      verdict: { ...receipt().verdict, action: 'quarantine' },
    })).toThrow(/must admit content/);
  });

  it('changes the screening contract digest for any contract drift', () => {
    const base = cogSecScreeningContractDigest(CONTRACT);
    expect(cogSecScreeningContractDigest({ ...CONTRACT })).toBe(base);
    expect(cogSecScreeningContractDigest({
      ...CONTRACT,
      scannerIds: ['url-scanner', 'intake-rule-engine'],
    })).toBe(base);
    for (const drifted of [
      { ...CONTRACT, ruleFingerprint: '17000000000000001:4096:12345' },
      { ...CONTRACT, policyDigest: cogSecPolicyDigest({ mode: 'strict' }) },
      { ...CONTRACT, globalMode: 'strict' as const },
      { ...CONTRACT, posture: 'shadow' as const },
      { ...CONTRACT, sourceRiskTier: 'hostile' as const },
      { ...CONTRACT, scanScope: 'strict' },
      { ...CONTRACT, scannerIds: ['intake-rule-engine'] },
      { ...CONTRACT, injectionScorerId: 'injection-classifier' },
      { ...CONTRACT, semanticLayers: { l2: 'clear', l3: 'not_run' } },
    ]) {
      expect(cogSecScreeningContractDigest(drifted)).not.toBe(base);
    }
  });

  it('digests a policy independently of its key order', () => {
    expect(cogSecPolicyDigest({ a: 1, nested: { x: true, y: [1, 2] } }))
      .toBe(cogSecPolicyDigest({ nested: { y: [1, 2], x: true }, a: 1 }));
    expect(cogSecPolicyDigest({ a: 1 })).not.toBe(cogSecPolicyDigest({ a: 2 }));
  });
});
