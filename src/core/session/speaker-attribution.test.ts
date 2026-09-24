import { describe, expect, it } from 'vitest';
import {
  buildSessionMetadataWithSpeakerAttribution,
  resolveProvenSpeakerContactId,
  resolveSessionEntrySpeakerContactId,
} from './speaker-attribution.js';

describe('session speaker attribution (bs4m0)', () => {
  it('only proves a contact for resolved human or machine-intelligence user speakers', () => {
    expect(resolveProvenSpeakerContactId({ speakerRole: 'user', actorKind: 'human', canonicalContactKey: ' c-1 ' }))
      .toBe('c-1');
    expect(resolveProvenSpeakerContactId({
      speakerRole: 'user',
      actorKind: 'machine_intelligence',
      canonicalContactKey: 'c-2',
    })).toBe('c-2');
    // A system speaker's key may be its raw author id: never proof.
    expect(resolveProvenSpeakerContactId({ speakerRole: 'system', actorKind: 'system', canonicalContactKey: 'raw' }))
      .toBeUndefined();
    expect(resolveProvenSpeakerContactId({ speakerRole: 'user', actorKind: 'unknown', canonicalContactKey: 'raw' }))
      .toBeUndefined();
    expect(resolveProvenSpeakerContactId({ speakerRole: 'user', actorKind: 'human' })).toBeUndefined();
  });

  it('round-trips attribution while preserving existing metadata', () => {
    const metadata = buildSessionMetadataWithSpeakerAttribution(JSON.stringify({ turn: { schemaVersion: 1 } }), 'c-1');
    expect(JSON.parse(metadata)).toMatchObject({ turn: { schemaVersion: 1 } });
    expect(resolveSessionEntrySpeakerContactId({ metadata })).toBe('c-1');
    expect(resolveSessionEntrySpeakerContactId({ metadata: JSON.stringify({ turn: {} }) })).toBeUndefined();
    expect(resolveSessionEntrySpeakerContactId({})).toBeUndefined();
  });

  it('fails closed on malformed attribution', () => {
    expect(() => buildSessionMetadataWithSpeakerAttribution(undefined, '  ')).toThrow();
    expect(() => resolveSessionEntrySpeakerContactId({ metadata: '{' })).toThrow();
    expect(() => resolveSessionEntrySpeakerContactId({
      metadata: JSON.stringify({ speakerAttribution: { schemaVersion: 2, canonicalContactId: 'c-1' } }),
    })).toThrow(/malformed/);
  });
});
