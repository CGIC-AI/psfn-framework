import { describe, expect, it } from 'vitest';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import {
  EGRESS_CAPABILITY_MATRIX_CASES,
  EGRESS_CAPABILITY_MATRIX_TIERS,
  runEgressCapabilityMatrixCertification,
} from './egress-capability-matrix.js';

describe('external capability egress matrix certification', () => {
  it('covers every canonical external capability exactly once', () => {
    const externalTokens = CAPABILITY_TOKENS.filter(token => token.startsWith('external.'));
    const coveredTokens = EGRESS_CAPABILITY_MATRIX_CASES.map(entry => entry.capability);

    expect(coveredTokens).toEqual(externalTokens);
    expect(new Set(coveredTokens).size).toBe(externalTokens.length);
  });

  it('executes every capability x tier row with exact deny-side-effect proof', async () => {
    const report = await runEgressCapabilityMatrixCertification();

    expect(report.status).toBe('passed');
    expect(report.rows).toHaveLength(
      EGRESS_CAPABILITY_MATRIX_CASES.length * EGRESS_CAPABILITY_MATRIX_TIERS.length,
    );
    for (const row of report.rows) {
      if (row.expected === 'allow') {
        expect(row.handlerInvocationCount, `${row.tier}/${row.capability}`).toBe(1);
        expect(row.denial).toBeNull();
      } else {
        expect(row.handlerInvocationCount, `${row.tier}/${row.capability}`).toBe(0);
        expect(row.denial).toEqual({
          capabilityDenied: true,
          tier: row.tier,
          missingTokens: [row.capability],
        });
      }
    }
  });
});
