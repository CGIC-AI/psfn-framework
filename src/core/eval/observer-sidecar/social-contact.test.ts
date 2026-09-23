import { describe, expect, it } from 'vitest';
import {
  buildEmoSimExternalActor,
  deriveObserverSocialContactKey,
  isObserverSocialContactKey,
} from './social-contact.js';

describe('observer social contact attribution', () => {
  it('derives an opaque key only for inbound turns from resolved humans or peer companions', () => {
    const human = deriveObserverSocialContactKey({
      speakerRole: 'user',
      actorKind: 'human',
      canonicalContactKey: 'contact-alice',
    });
    const peer = deriveObserverSocialContactKey({
      speakerRole: 'user',
      actorKind: 'machine_intelligence',
      canonicalContactKey: 'contact-peer-companion',
    });
    expect(isObserverSocialContactKey(human)).toBe(true);
    expect(isObserverSocialContactKey(peer)).toBe(true);
    expect(human).not.toBe(peer);
    expect(human).not.toContain('alice');
    // Stable per contact, so repeated contact is the same social source.
    expect(deriveObserverSocialContactKey({
      speakerRole: 'user',
      actorKind: 'human',
      canonicalContactKey: ' contact-alice ',
    })).toBe(human);
  });

  it('never treats reflection, scheduler, outbound, or unresolved turns as contact', () => {
    const nonSocial = [
      { speakerRole: 'system', actorKind: 'system', canonicalContactKey: 'contact-alice' },
      { speakerRole: 'system', actorKind: 'machine_intelligence', canonicalContactKey: 'contact-peer' },
      { speakerRole: 'user', actorKind: 'unknown', canonicalContactKey: 'contact-alice' },
      { speakerRole: 'user', actorKind: 'system', canonicalContactKey: 'contact-alice' },
      { speakerRole: 'user', actorKind: 'human' },
      { speakerRole: 'user', actorKind: 'human', canonicalContactKey: '   ' },
    ] as const;
    for (const evidence of nonSocial) {
      expect(deriveObserverSocialContactKey(evidence)).toBeUndefined();
    }
  });

  it('builds a session-scoped emo_sim external actor and rejects malformed keys', () => {
    const key = deriveObserverSocialContactKey({
      speakerRole: 'user',
      actorKind: 'human',
      canonicalContactKey: 'contact-alice',
    })!;
    const first = buildEmoSimExternalActor('companion-a-session', key);
    const second = buildEmoSimExternalActor('companion-b-session', key);
    expect(first).toMatchObject({ schema_version: 1, kind: 'canonical_contact' });
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.key).not.toBe(key);
    expect(second.key).not.toBe(first.key);
    expect(buildEmoSimExternalActor('companion-a-session', key)).toEqual(first);

    expect(() => buildEmoSimExternalActor('companion-a-session', 'contact-alice'))
      .toThrow('64-hex observer social contact key');
    expect(() => buildEmoSimExternalActor('companion-a-session', key.toUpperCase()))
      .toThrow('64-hex observer social contact key');
    expect(() => buildEmoSimExternalActor('  ', key)).toThrow('session label');
  });
});
