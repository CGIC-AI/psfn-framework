import { describe, expect, it } from 'vitest';
import {
  auditCompanionMemoryProvenance,
  evaluateCompanionMemoryProvenance,
} from './companion-provenance.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';
const DM_A_B = `companion-dm:${COMPANION_A}:${COMPANION_B}`;

describe('companion memory provenance', () => {
  it('allows ordinary memory and exact participants in a canonical companion DM', () => {
    expect(evaluateCompanionMemoryProvenance({
      sourceRef: 'api:ordinary',
      provenance: { channelId: 'api:ordinary' },
    }, undefined)).toEqual({ allowed: true, channelKind: 'non_companion' });
    expect(evaluateCompanionMemoryProvenance({
      sourceRef: `${DM_A_B}:extract|source:session|session:private-ab|operation:extract`,
      provenance: { channelId: DM_A_B, sessionId: 'private-ab' },
    }, COMPANION_A)).toEqual({ allowed: true, channelKind: 'dm' });
  });

  it('rejects a third companion plus missing, mismatched, and malformed ICP authority', () => {
    const exact = {
      sourceRef: `${DM_A_B}:extract|source:session|session:private-ab|operation:extract`,
      provenance: { channelId: DM_A_B, sessionId: 'private-ab' },
    };
    expect(evaluateCompanionMemoryProvenance(exact, COMPANION_C)).toMatchObject({
      allowed: false,
      reason: 'foreign_companion_dm',
    });
    expect(evaluateCompanionMemoryProvenance({
      sourceRef: exact.sourceRef,
    }, COMPANION_A)).toMatchObject({
      allowed: false,
      reason: 'missing_companion_channel_provenance',
    });
    expect(evaluateCompanionMemoryProvenance({
      ...exact,
      provenance: { channelId: `companion-dm:${COMPANION_A}:${COMPANION_C}` },
    }, COMPANION_A)).toMatchObject({
      allowed: false,
      reason: 'mismatched_companion_channel_provenance',
    });
    expect(evaluateCompanionMemoryProvenance({
      provenance: { channelId: `companion-dm:${COMPANION_B}:${COMPANION_A}` },
    }, COMPANION_A)).toMatchObject({
      allowed: false,
      reason: 'malformed_companion_channel',
    });
    expect(evaluateCompanionMemoryProvenance(exact, undefined)).toMatchObject({
      allowed: false,
      reason: 'missing_companion_authority',
    });
  });

  it('audits exact row ids with digested provenance and never returns memory content', () => {
    const report = auditCompanionMemoryProvenance([
      {
        id: 'memory-owned',
        sourceRef: 'api:ordinary',
        provenance: { channelId: 'api:ordinary' },
      },
      {
        id: 'memory-contaminated',
        sourceRef: `${DM_A_B}:extract|source:session|session:private-ab|operation:extract`,
        provenance: { channelId: DM_A_B, sessionId: 'private-ab' },
        state: 'active',
      },
    ], COMPANION_C);

    expect(report).toMatchObject({
      inspectedCount: 2,
      contaminatedCount: 1,
      reasonCounts: { foreign_companion_dm: 1 },
    });
    expect(report.findings[0]).toEqual({
      memoryId: 'memory-contaminated',
      state: 'active',
      reason: 'foreign_companion_dm',
      channelKind: 'dm',
      sourceRefDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sessionRefDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(report)).not.toContain('private-ab');
    expect(JSON.stringify(report)).not.toContain(DM_A_B);
  });
});
