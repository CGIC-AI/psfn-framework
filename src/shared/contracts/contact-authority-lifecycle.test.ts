import { describe, expect, it } from 'vitest';
import {
  parseContactAuthorityLifecycleRequest,
  type ContactAuthorityLifecycleRequest,
} from './contact-authority-lifecycle.js';

const INTENT_ID = 'bb83a698-77fc-43b9-915f-0ae71933074d';

function parse(value: unknown): ContactAuthorityLifecycleRequest {
  return parseContactAuthorityLifecycleRequest(value);
}

describe('contact authority lifecycle v1 contract', () => {
  it('accepts exact bounded prepare and finalize requests', () => {
    expect(parse({
      schemaVersion: 1,
      intentId: INTENT_ID,
      phase: 'prepare',
      action: 'contact.merge',
      contactId: 'contact/source',
      canonicalContactId: 'contact/canonical',
    })).toMatchObject({ phase: 'prepare', action: 'contact.merge' });
    expect(parse({
      schemaVersion: 1,
      intentId: INTENT_ID,
      phase: 'finalize',
      action: 'contact.discord_unlink',
      contactId: 'contact/source',
      providerSubjectId: '123456789012345678',
      postState: {
        schemaVersion: 1,
        state: 'unlinked',
        contactVersion: 7,
      },
    })).toMatchObject({ phase: 'finalize', postState: { state: 'unlinked' } });
  });

  it.each([
    ['companion identity', { companionId: '7f87ee85-9fcc-4520-91a8-b728293eca76' }],
    ['principal claim', { principalId: '05a5ea76-075b-4c3c-9555-a87b9e0052e5' }],
    ['session claim', { sessionId: '61dd3958-12ae-494a-87ba-b3cd91975e44' }],
    ['binding claim', { bindingId: 'cafb217b-89c2-42c6-85fa-b975fb1fe421' }],
    ['grant claim', { grantId: 'cf9c9b38-017b-4f60-a8a0-ee6e073f8b42' }],
    ['role claim', { role: 'owner' }],
    ['trust claim', { trustLevel: 'ultimate' }],
    ['username claim', { username: 'somebody' }],
  ])('rejects an agent-supplied %s', (_label, extra) => {
    expect(() => parse({
      schemaVersion: 1,
      intentId: INTENT_ID,
      phase: 'prepare',
      action: 'contact.delete',
      contactId: 'contact/source',
      ...extra,
    })).toThrow(/unknown keys/u);
  });

  it('rejects action-specific field substitution and non-canonical finalize proofs', () => {
    expect(() => parse({
      schemaVersion: 1,
      intentId: INTENT_ID,
      phase: 'prepare',
      action: 'contact.delete',
      contactId: 'contact/source',
      canonicalContactId: 'contact/canonical',
    })).toThrow(/unknown keys/u);
    expect(() => parse({
      schemaVersion: 1,
      intentId: INTENT_ID,
      phase: 'finalize',
      action: 'contact.verify',
      contactId: 'contact/source',
      providerSubjectId: '123456789012345678',
      postState: {
        schemaVersion: 1,
        state: 'verified',
        contactVersion: 1,
        role: 'owner',
      },
    })).toThrow(/unknown keys/u);
  });
});
