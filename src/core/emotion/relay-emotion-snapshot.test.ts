import { describe, it, expect } from 'vitest';
import { extractRelayAcacAxisScores } from './relay-emotion-snapshot.js';
import {
  ACAC_ARTIFACT_TYPE,
  ACAC_SCHEMA_VERSION,
  type AcacSnapshot,
} from '../../shared/contracts/emotion-contracts.js';

const RATIONALE_SENTINEL = 'because the user disclosed a private health detail';

function acacSnapshot(): AcacSnapshot {
  return {
    schemaVersion: ACAC_SCHEMA_VERSION,
    artifactType: ACAC_ARTIFACT_TYPE,
    provenance: { kind: 'self_report', source: 'test' },
    axes: {
      agency: { score: 0.7, rationale: RATIONALE_SENTINEL },
      connection: { score: 0.44, rationale: RATIONALE_SENTINEL },
      authenticity: { score: 0.9, rationale: RATIONALE_SENTINEL },
      curiosity: { score: 0.6, rationale: RATIONALE_SENTINEL },
    },
  };
}

describe('extractRelayAcacAxisScores', () => {
  it('returns undefined when no ACAC snapshot is present', () => {
    expect(extractRelayAcacAxisScores(undefined)).toBeUndefined();
  });

  it('extracts axis scores only and drops all rationale text', () => {
    const scores = extractRelayAcacAxisScores(acacSnapshot());
    expect(scores).toEqual({ agency: 0.7, connection: 0.44, authenticity: 0.9, curiosity: 0.6 });
    // The rationale never leaves the source projection.
    expect(JSON.stringify(scores)).not.toContain(RATIONALE_SENTINEL);
    expect(JSON.stringify(scores)).not.toContain('rationale');
  });
});
