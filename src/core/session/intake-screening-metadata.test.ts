// ── Session-entry intake screening metadata tests (htm9.2) ──

import { describe, expect, it } from 'vitest';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import {
  buildSessionMetadataWithIntakeScreening,
  parseIntakeScreeningMetadata,
} from './intake-screening-metadata.js';

const snapshot: IntakeEnvelopeSnapshot = {
  envelopeId: 'env-12345678',
  sourceClass: 'tool_output',
  sourceRiskTier: 'untrusted',
  state: 'quarantined',
  riskLabels: ['injection/override_attempt'],
  subject: { kind: 'body' },
};

describe('intake screening session metadata', () => {
  it('round-trips through the metadata envelope alongside existing keys', () => {
    const existing = JSON.stringify({ sessionLane: 'voice' });
    const metadata = buildSessionMetadataWithIntakeScreening(existing, {
      mode: 'enforce',
      withheld: true,
      envelopes: [snapshot],
    });

    const parsedEnvelope = JSON.parse(metadata) as Record<string, unknown>;
    expect(parsedEnvelope.sessionLane).toBe('voice');

    const parsed = parseIntakeScreeningMetadata(metadata);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe('enforce');
    expect(parsed?.withheld).toBe(true);
    expect(parsed?.envelopes).toEqual([snapshot]);
  });

  it('returns null when the key is absent and rejects malformed payloads', () => {
    expect(parseIntakeScreeningMetadata(undefined)).toBeNull();
    expect(parseIntakeScreeningMetadata(JSON.stringify({ other: 1 }))).toBeNull();

    expect(() => parseIntakeScreeningMetadata(JSON.stringify({
      intakeScreening: { schemaVersion: 99 },
    }))).toThrow(/schemaVersion/);
    expect(() => parseIntakeScreeningMetadata(JSON.stringify({
      intakeScreening: { schemaVersion: 1, mode: 'loud', withheld: false, envelopes: [snapshot] },
    }))).toThrow(/mode/);
    expect(() => parseIntakeScreeningMetadata(JSON.stringify({
      intakeScreening: {
        schemaVersion: 1,
        mode: 'shadow',
        withheld: false,
        envelopes: [{ ...snapshot, riskLabels: ['made/up_label'] }],
      },
    }))).toThrow(/riskLabels/);
  });

  it('requires at least one envelope snapshot', () => {
    expect(() => buildSessionMetadataWithIntakeScreening(undefined, {
      mode: 'shadow',
      withheld: false,
      envelopes: [],
    })).toThrow(/at least one envelope/);
  });
});
