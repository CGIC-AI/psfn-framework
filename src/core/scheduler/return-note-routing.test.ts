import { describe, expect, it } from 'vitest';
import type { DisclosureDestination } from '../cogsec/disclosure/index.js';
import type { FreeTimeReturnPolicy } from './free-time-workspace-resolver.js';
import {
  returnPolicyToDisclosureDestination,
  routeReturnNote,
  type ReturnNoteRoutingPorts,
} from './return-note-routing.js';

function ports(overrides: Partial<ReturnNoteRoutingPorts> = {}): ReturnNoteRoutingPorts {
  return {
    privateSelfSessionId: 'api:main',
    workspaceSessionId: 'internal:free-time:private',
    ...overrides,
  };
}

// ── FreeTimeReturnPolicy → DisclosureDestination mapping (bible §10.8) ──

describe('returnPolicyToDisclosureDestination', () => {
  it('maps contact_dm to a contact_dm destination carrying the contactId', () => {
    const policy: FreeTimeReturnPolicy = { kind: 'contact_dm', contactId: 'contact-a' };
    expect(returnPolicyToDisclosureDestination(policy)).toEqual({ kind: 'contact_dm', contactId: 'contact-a' });
  });

  it('maps private_self to the companion-self private sink', () => {
    expect(returnPolicyToDisclosureDestination({ kind: 'private_self' })).toEqual({ kind: 'companion_self' });
  });

  it('maps room to the resolver-computed room disclosure ceiling (invite-only)', () => {
    const policy: FreeTimeReturnPolicy = { kind: 'room', channelId: 'discord:room-1' };
    const ceiling: DisclosureDestination = { kind: 'invite_only_room', channelId: 'discord:room-1' };
    expect(returnPolicyToDisclosureDestination(policy, ceiling)).toEqual(ceiling);
  });

  it('maps room to a public_room ceiling when the channel is public', () => {
    const policy: FreeTimeReturnPolicy = { kind: 'room', channelId: 'discord:room-2' };
    const ceiling: DisclosureDestination = { kind: 'public_room', channelId: 'discord:room-2' };
    expect(returnPolicyToDisclosureDestination(policy, ceiling)).toEqual(ceiling);
  });

  it('fails closed to companion_self for a room policy WITHOUT a room-kind ceiling', () => {
    const policy: FreeTimeReturnPolicy = { kind: 'room', channelId: 'discord:room-1' };
    // A non-room ceiling (or none) must never be coerced into a guessed room.
    expect(returnPolicyToDisclosureDestination(policy, { kind: 'companion_self' })).toEqual({ kind: 'companion_self' });
    expect(returnPolicyToDisclosureDestination(policy)).toEqual({ kind: 'companion_self' });
  });

  it('maps publication_state to the publication destination', () => {
    const policy: FreeTimeReturnPolicy = { kind: 'publication_state', projectRef: 'project:p', mode: 'public_clean' };
    expect(returnPolicyToDisclosureDestination(policy)).toEqual({ kind: 'publication' });
  });

  it('throws (fails closed) on an unknown return policy kind', () => {
    expect(() => returnPolicyToDisclosureDestination({ kind: 'nonsense' } as unknown as FreeTimeReturnPolicy))
      .toThrow(/unknown free-time return policy/i);
  });
});

// ── Routing: destination → append target (bible §10.8, fail-closed) ──

describe('routeReturnNote', () => {
  it('routes companion_self to the private-self session with content allowed', () => {
    const route = routeReturnNote({ kind: 'companion_self' }, ports());
    expect(route).toMatchObject({
      targetSessionId: 'api:main',
      isPublicationState: false,
      contentAllowed: true,
    });
    expect(route.destination).toEqual({ kind: 'companion_self' });
  });

  it('routes a contact_dm to the resolved DM session when the contact resolves', () => {
    const route = routeReturnNote(
      { kind: 'contact_dm', contactId: 'contact-a' },
      ports({ resolveContactDmSessionId: id => (id === 'contact-a' ? 'discord:dm-a' : null) }),
    );
    expect(route.targetSessionId).toBe('discord:dm-a');
    expect(route.contentAllowed).toBe(true);
    expect(route.destination).toEqual({ kind: 'contact_dm', contactId: 'contact-a' });
  });

  it('COLLAPSES an unresolvable contact_dm to a content-free private/self note', () => {
    const route = routeReturnNote(
      { kind: 'contact_dm', contactId: 'contact-a' },
      ports({ resolveContactDmSessionId: () => null }),
    );
    // Never a wrong-destination append: falls back to private/self, content-free.
    expect(route.targetSessionId).toBe('api:main');
    expect(route.destination).toEqual({ kind: 'companion_self' });
    expect(route.contentAllowed).toBe(false);
    expect(route.isPublicationState).toBe(false);
  });

  it('COLLAPSES a contact_dm when NO resolver port is wired', () => {
    const route = routeReturnNote({ kind: 'contact_dm', contactId: 'contact-a' }, ports());
    expect(route.targetSessionId).toBe('api:main');
    expect(route.contentAllowed).toBe(false);
  });

  it('routes an invite_only_room to the same room session', () => {
    const route = routeReturnNote({ kind: 'invite_only_room', channelId: 'discord:room-1' }, ports());
    expect(route.targetSessionId).toBe('discord:room-1');
    expect(route.contentAllowed).toBe(true);
    expect(route.destination).toEqual({ kind: 'invite_only_room', channelId: 'discord:room-1' });
  });

  it('routes a public_room to the same room session', () => {
    const route = routeReturnNote({ kind: 'public_room', channelId: 'discord:room-2' }, ports());
    expect(route.targetSessionId).toBe('discord:room-2');
    expect(route.contentAllowed).toBe(true);
  });

  it('COLLAPSES a room destination with an empty channel id to private/self', () => {
    const route = routeReturnNote({ kind: 'invite_only_room', channelId: '   ' }, ports());
    expect(route.targetSessionId).toBe('api:main');
    expect(route.contentAllowed).toBe(false);
    expect(route.destination).toEqual({ kind: 'companion_self' });
  });

  it('routes publication to a STATE update on the workspace session (no content)', () => {
    const route = routeReturnNote({ kind: 'publication' }, ports());
    expect(route.targetSessionId).toBe('internal:free-time:private');
    expect(route.isPublicationState).toBe(true);
    expect(route.contentAllowed).toBe(false);
  });
});
