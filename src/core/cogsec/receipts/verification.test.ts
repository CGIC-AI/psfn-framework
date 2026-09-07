import { describe, expect, it } from 'vitest';

import {
  COGSEC_INTAKE_FIREWALL_ISSUER_ID,
  cogSecContentSha256,
  cogSecPolicyDigest,
  cogSecScreeningContractDigest,
  createCogSecReceipt,
  type CogSecReceipt,
} from '../../../shared/contracts/cogsec-receipt.js';
import type { CogSecReceiptLookupQuery, CogSecReceiptStorePort } from './contracts.js';
import { resolveAdmittedCogSecReceipt, verifyCogSecReceipt } from './verification.js';

const CONTENT = 'the tram was on time';
const CONTRACT_DIGEST = cogSecScreeningContractDigest({
  policyDigest: cogSecPolicyDigest({ mode: 'boundary' }),
  ruleFingerprint: '17000000000000000:4096:12345',
  globalMode: 'boundary',
  posture: 'enforce',
  cogsecVector: 'boundary_external',
  sourceClass: 'document',
  sourceRiskTier: 'untrusted',
  scanScope: 'context',
  scannerIds: ['intake-rule-engine'],
  semanticLayers: { l2: 'not_run', l3: 'not_run' },
});
const TRUSTED = [COGSEC_INTAKE_FIREWALL_ISSUER_ID];

function mint(overrides: Partial<Parameters<typeof createCogSecReceipt>[0]> = {}): CogSecReceipt {
  return createCogSecReceipt({
    receiptId: 'receipt-1',
    issuer: { id: COGSEC_INTAKE_FIREWALL_ISSUER_ID, instance: 'agent:intake-screening' },
    issuedAtMs: 1_000,
    expiresAtMs: 5_000,
    admittedContent: CONTENT,
    rawContent: CONTENT,
    screeningContractDigest: CONTRACT_DIGEST,
    verdict: {
      envelopeId: 'envelope-00000001',
      action: 'pass',
      state: 'released',
      posture: 'enforce',
      globalMode: 'boundary',
      sourceClass: 'document',
      sourceRiskTier: 'untrusted',
      decidedAtMs: 1_000,
      riskLabels: [],
    },
    lineage: [{
      stage: 'raw_intake',
      outputSha256: cogSecContentSha256(CONTENT),
      transformId: 'intake',
    }],
    ...overrides,
  });
}

function memoryStore(receipts: readonly CogSecReceipt[]): CogSecReceiptStorePort {
  return {
    record: async () => { throw new Error('unused'); },
    findLatestForContent: async (query: CogSecReceiptLookupQuery) => receipts
      .filter(entry => entry.contentSha256 === query.contentSha256
        && entry.screeningContractDigest === query.screeningContractDigest)
      .sort((a, b) => b.issuedAtMs - a.issuedAtMs)[0] ?? null,
    getById: async (id: string) => receipts.find(entry => entry.receiptId === id) ?? null,
    close: async () => {},
  };
}

function verify(input: Partial<Parameters<typeof verifyCogSecReceipt>[0]> = {}) {
  return verifyCogSecReceipt({
    receipt: mint(),
    content: CONTENT,
    expectedScreeningContractDigest: CONTRACT_DIGEST,
    trustedIssuerIds: TRUSTED,
    nowMs: 2_000,
    ...input,
  });
}

describe('CogSec receipt verification', () => {
  it('admits only the exact bytes the receipt covers', () => {
    expect(verify()).toMatchObject({ admitted: true });
    expect(verify({ content: `${CONTENT} ` })).toMatchObject({
      admitted: false,
      reason: 'content_hash_mismatch',
    });
  });

  it('refuses an issuer outside the caller trusted set, including an empty set', () => {
    expect(verify({ trustedIssuerIds: ['cogsec:other-authority'] })).toMatchObject({
      admitted: false,
      reason: 'unknown_issuer',
    });
    expect(verify({ trustedIssuerIds: [] })).toMatchObject({
      admitted: false,
      reason: 'unknown_issuer',
    });
    expect(verify({
      receipt: mint({ issuer: { id: 'skills:self-signed', instance: 'faculty' } }),
    })).toMatchObject({ admitted: false, reason: 'unknown_issuer' });
  });

  it('refuses at and after expiry', () => {
    expect(verify({ nowMs: 4_999 })).toMatchObject({ admitted: true });
    expect(verify({ nowMs: 5_000 })).toMatchObject({ admitted: false, reason: 'expired' });
    expect(verify({ nowMs: 9_999 })).toMatchObject({ admitted: false, reason: 'expired' });
  });

  it('refuses a drifted screening contract and a tampered receipt', () => {
    expect(verify({ expectedScreeningContractDigest: cogSecContentSha256('other contract') }))
      .toMatchObject({ admitted: false, reason: 'screening_contract_mismatch' });
    expect(verify({ receipt: { ...mint(), expiresAtMs: 9_999_999 } }))
      .toMatchObject({ admitted: false, reason: 'malformed' });
    expect(verify({ receipt: { nonsense: true } }))
      .toMatchObject({ admitted: false, reason: 'malformed' });
  });

  it('looks up and verifies in one step, and reports a miss as not_found', async () => {
    const store = memoryStore([mint()]);
    await expect(resolveAdmittedCogSecReceipt(store, {
      content: CONTENT,
      expectedScreeningContractDigest: CONTRACT_DIGEST,
      trustedIssuerIds: TRUSTED,
      nowMs: 2_000,
    })).resolves.toMatchObject({ admitted: true });
    await expect(resolveAdmittedCogSecReceipt(store, {
      content: 'different bytes',
      expectedScreeningContractDigest: CONTRACT_DIGEST,
      trustedIssuerIds: TRUSTED,
      nowMs: 2_000,
    })).resolves.toMatchObject({ admitted: false, reason: 'not_found' });
    await expect(resolveAdmittedCogSecReceipt(store, {
      content: CONTENT,
      expectedScreeningContractDigest: CONTRACT_DIGEST,
      trustedIssuerIds: TRUSTED,
      nowMs: 6_000,
    })).resolves.toMatchObject({ admitted: false, reason: 'expired' });
  });

  it('does not swallow a store failure into a silent refusal', async () => {
    const failing: CogSecReceiptStorePort = {
      ...memoryStore([]),
      findLatestForContent: async () => { throw new Error('connection reset'); },
    };
    await expect(resolveAdmittedCogSecReceipt(failing, {
      content: CONTENT,
      expectedScreeningContractDigest: CONTRACT_DIGEST,
      trustedIssuerIds: TRUSTED,
      nowMs: 2_000,
    })).rejects.toThrow('connection reset');
  });
});
