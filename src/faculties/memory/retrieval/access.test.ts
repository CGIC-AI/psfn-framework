import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../types.js';
import { evaluateRetrievalAccessDecision } from './access.js';

const PRIMARY_CONTACT_ID = 'contact-primary';
const PRIMARY_DM_ID = 'discord:dm:primary';

function memory(
  overrides: Partial<Pick<PurrMemory, 'sensitivity' | 'contactId' | 'provenance' | 'scopeRef' | 'scopeTags'>> = {},
): Pick<
  PurrMemory,
  | 'sensitivity'
  | 'contactId'
  | 'consentFlags'
  | 'tags'
  | 'provenance'
  | 'scopeRef'
  | 'scopeTags'
> {
  return {
    sensitivity: 'personal',
    tags: [],
    ...overrides,
  };
}

function primaryDmOptions() {
  return {
    trustLevel: 'primary' as const,
    channelPrivacy: 'private' as const,
    broadcast: false,
    canonicalContactId: PRIMARY_CONTACT_ID,
    roomVisibility: {
      currentChannelId: PRIMARY_DM_ID,
      currentIsDirectMessage: true,
      canonicalContactRoomIds: new Set([PRIMARY_DM_ID]),
    },
  };
}

describe('evaluateRetrievalAccessDecision participant-aware DM access', () => {
  it.each([
    ['voice', 'voice:retired-session'],
    ['telegram', 'telegram:retired-session'],
    ['satellite', 'satellite:retired-session'],
  ])('allows the primary partner to recall their memory from an unlisted %s channel', (_kind, channelId) => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        contactId: PRIMARY_CONTACT_ID,
        provenance: { channelId },
      }),
      primaryDmOptions(),
    );

    expect(decision).toEqual({ allowed: true });
  });

  it('allows a true unbound non-intimate self-memory in the primary partner DM', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory(),
      primaryDmOptions(),
    );

    expect(decision).toEqual({ allowed: true });
  });

  it('blocks an unbound intimate group-room memory in the primary partner DM', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        sensitivity: 'intimate',
        provenance: { channelId: 'discord:guild:shared-room' },
        scopeRef: { kind: 'conversation', id: 'discord:guild:shared-room' },
      }),
      primaryDmOptions(),
    );

    expect(decision).toEqual({
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    });
  });

  it('fails closed on conflicting room provenance before the primary DM exemption', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        contactId: PRIMARY_CONTACT_ID,
        provenance: { channelId: 'discord:guild:source-room' },
        scopeRef: { kind: 'conversation', id: 'discord:guild:conflicting-room' },
      }),
      primaryDmOptions(),
    );

    expect(decision).toEqual({
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    });
  });

  it('never exposes a DM-origin memory in a group room', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        contactId: PRIMARY_CONTACT_ID,
        provenance: { channelId: PRIMARY_DM_ID },
      }),
      {
        trustLevel: 'primary',
        channelPrivacy: 'invite_only',
        broadcast: false,
        canonicalContactId: PRIMARY_CONTACT_ID,
        roomVisibility: {
          currentChannelId: 'discord:guild:shared-room',
          currentIsDirectMessage: false,
        },
      },
    );

    expect(decision).toEqual({
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    });
  });

  it('keeps another contact\'s intimate memory out of the primary partner\'s DM', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        sensitivity: 'intimate',
        contactId: 'contact-other',
        provenance: { channelId: PRIMARY_DM_ID },
      }),
      primaryDmOptions(),
    );

    expect(decision).toEqual({
      allowed: false,
      rejectionKind: 'contact_scope',
      withheldReason: 'contact_scope.high_intimacy',
    });
  });

  it('does not use subject ownership to leak another contact\'s private DM', () => {
    const decision = evaluateRetrievalAccessDecision(
      memory({
        contactId: PRIMARY_CONTACT_ID,
        provenance: {
          channelId: 'discord:dm:other',
          sourceContactId: 'contact-other',
          subjectContactId: PRIMARY_CONTACT_ID,
        },
      }),
      primaryDmOptions(),
    );

    expect(decision).toEqual({
      allowed: false,
      rejectionKind: 'room_visibility',
      withheldReason: 'room_visibility.blocked',
    });
  });
});
