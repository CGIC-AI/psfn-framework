import { describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/types.js';
import {
  provisionFleetContactTopology,
  verifyFleetContactTopology,
} from './fleet-contact-provisioning.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '12345678901234567';
const ADMIN = '23456789012345678';

function fakeStore(initial: Contact[] = []): {
  contacts: Contact[];
  setMachineIntelligence: ReturnType<typeof vi.fn>;
  setTrustLevel: ReturnType<typeof vi.fn>;
  store: ContactStorePort;
} {
  const contacts = initial.map(contact => structuredClone(contact));
  const identity = new Map<string, Contact>();
  for (const contact of contacts) {
    for (const channel of contact.channels ?? []) {
      identity.set(`${channel.channel}:${channel.userId}`, contact);
    }
  }
  const setMachineIntelligence = vi.fn(async (id: string, value: boolean) => {
    const contact = contacts.find(candidate => candidate.id === id);
    if (!contact) return false;
    contact.isMachineIntelligence = value;
    return true;
  });
  const setTrustLevel = vi.fn();
  const store = {
    async getByChannelIdentity(channel: string, userId: string) {
      return identity.get(`${channel}:${userId}`);
    },
    async getById(id: string) {
      return contacts.find(contact => contact.id === id);
    },
    async resolveChannelIdentity(channel: string, userId: string, displayName: string) {
      const key = `${channel}:${userId}`;
      const existing = identity.get(key);
      if (existing) return existing;
      const contact = {
        id: `${channel}-${userId}`,
        displayName,
        trustLevel: 'public',
        relationshipType: channel === 'companion' ? 'acquaintance' : 'stranger',
        isMachineIntelligence: false,
        emotionalBaseline: {},
        firstSeen: '2026-07-30T00:00:00.000Z',
        lastSeen: '2026-07-30T00:00:00.000Z',
        channels: [{ channel, userId, privacyLevel: 'private' }],
      } satisfies Contact;
      contacts.push(contact);
      identity.set(key, contact);
      return contact;
    },
    async upsert(partial: Partial<Contact> & { displayName: string }) {
      const channel = partial.channels?.[0];
      if (!channel) throw new Error('test upsert requires an identity');
      const existing = identity.get(`${channel.channel}:${channel.userId}`);
      if (existing) return existing;
      const contact = {
        id: partial.id ?? `${channel.channel}-${channel.userId}`,
        displayName: partial.displayName,
        trustLevel: partial.trustLevel ?? 'regular',
        relationshipType: partial.relationshipType ?? 'stranger',
        isMachineIntelligence: false,
        emotionalBaseline: {},
        firstSeen: '2026-07-30T00:00:00.000Z',
        lastSeen: '2026-07-30T00:00:00.000Z',
        channels: [channel],
        ...(partial.discordUserId ? { discordUserId: partial.discordUserId } : {}),
      } satisfies Contact;
      contacts.push(contact);
      identity.set(`${channel.channel}:${channel.userId}`, contact);
      return contact;
    },
    async linkChannelIdentity(id: string, channel: string, userId: string) {
      const contact = contacts.find(candidate => candidate.id === id);
      if (!contact) return 'contact_not_found';
      const key = `${channel}:${userId}`;
      const current = identity.get(key);
      if (current) return current.id === id ? 'already_linked' : 'identity_conflict';
      contact.channels.push({ channel, userId, privacyLevel: 'private' });
      if (channel === 'discord') contact.discordUserId = userId;
      identity.set(key, contact);
      return 'linked';
    },
    setMachineIntelligence,
    setTrustLevel,
    async updateIdentityProfile(id: string, displayName: string, nickname?: string) {
      const contact = contacts.find(candidate => candidate.id === id);
      if (!contact) return false;
      contact.displayName = displayName;
      if (nickname !== undefined) contact.nickname = nickname;
      return true;
    },
    async updateRelationshipType(id: string, relationshipType: Contact['relationshipType']) {
      const contact = contacts.find(candidate => candidate.id === id);
      if (!contact) return false;
      contact.relationshipType = relationshipType;
      return true;
    },
  } as unknown as ContactStorePort;
  return { contacts, setMachineIntelligence, setTrustLevel, store };
}

const companions = [
  { companionId: COMPANION_A, displayName: 'Selene' },
  { companionId: COMPANION_B, displayName: 'Nova Unit One' },
] as const;
const accountRoster = [
  {
    providerSubjectId: OPERATOR,
    companionId: COMPANION_A,
    contactId: 'operator-a',
    role: 'owner',
  },
  {
    providerSubjectId: OPERATOR,
    companionId: COMPANION_B,
    contactId: 'operator-b',
    role: 'owner',
  },
  {
    providerSubjectId: ADMIN,
    companionId: COMPANION_A,
    role: 'admin',
  },
  {
    providerSubjectId: ADMIN,
    companionId: COMPANION_B,
    role: 'admin',
  },
] as const;

describe('fleet contact provisioning', () => {
  it('seeds sibling and admin/operator relationships at public trust without setting tiers', async () => {
    const ownerA = fakeStore();
    const ownerB = fakeStore();
    const stores = new Map([
      [COMPANION_A, ownerA.store],
      [COMPANION_B, ownerB.store],
    ]);

    await provisionFleetContactTopology({ companions, ssoProvider: 'discord', accountRoster, stores });

    for (const owner of [ownerA, ownerB]) {
      expect(owner.setMachineIntelligence).not.toHaveBeenCalled();
      expect(owner.setTrustLevel).not.toHaveBeenCalled();
      expect(owner.contacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          trustLevel: 'public',
          relationshipType: 'ai_companion',
          isMachineIntelligence: false,
        }),
        expect.objectContaining({
          discordUserId: OPERATOR,
          trustLevel: 'public',
          relationshipType: 'friend',
        }),
        expect.objectContaining({
          discordUserId: ADMIN,
          trustLevel: 'public',
          relationshipType: 'acquaintance',
        }),
      ]));
    }
    expect(ownerA.contacts.find(contact => contact.discordUserId === OPERATOR)?.id)
      .toBe('operator-a');
    expect(ownerB.contacts.find(contact => contact.discordUserId === OPERATOR)?.id)
      .toBe('operator-b');
  });

  it('verifies only existence and relationship type, never trust tiers', async () => {
    const ownerA = fakeStore();
    const ownerB = fakeStore();
    const stores = new Map([
      [COMPANION_A, ownerA.store],
      [COMPANION_B, ownerB.store],
    ]);
    await provisionFleetContactTopology({ companions, ssoProvider: 'discord', accountRoster, stores });

    for (const contact of [...ownerA.contacts, ...ownerB.contacts]) {
      contact.trustLevel = contact.discordUserId === OPERATOR ? 'trusted' : 'regular';
    }
    await expect(verifyFleetContactTopology({ companions, ssoProvider: 'discord', accountRoster, stores }))
      .resolves.toMatchObject({ companionCount: 2, siblingContactCount: 2, humanContactCount: 4 });

    const sibling = ownerA.contacts.find(contact => contact.relationshipType === 'ai_companion');
    if (!sibling) throw new Error('missing test sibling');
    sibling.relationshipType = 'stranger';
    await expect(verifyFleetContactTopology({ companions, ssoProvider: 'discord', accountRoster, stores }))
      .rejects.toThrow(/expected relationship ai_companion/u);
  });

  it('links a configured existing operator contact without changing its trust tier', async () => {
    const existingOperator = {
      id: 'operator-a',
      displayName: 'Existing operator',
      trustLevel: 'trusted',
      relationshipType: 'stranger',
      isMachineIntelligence: false,
      emotionalBaseline: {},
      firstSeen: '2026-07-29T00:00:00.000Z',
      lastSeen: '2026-07-29T00:00:00.000Z',
      channels: [],
    } satisfies Contact;
    const ownerA = fakeStore([existingOperator]);
    const ownerB = fakeStore();
    const stores = new Map([
      [COMPANION_A, ownerA.store],
      [COMPANION_B, ownerB.store],
    ]);

    await provisionFleetContactTopology({ companions, ssoProvider: 'discord', accountRoster, stores });

    expect(ownerA.contacts.find(contact => contact.id === 'operator-a')).toMatchObject({
      discordUserId: OPERATOR,
      trustLevel: 'trusted',
      relationshipType: 'friend',
    });
    expect(ownerA.setTrustLevel).not.toHaveBeenCalled();
  });

  it('provisions companion-to-companion contacts in key mode with no SSO roster (key-or-SSO ruling)', async () => {
    const ownerA = fakeStore();
    const ownerB = fakeStore();
    const stores = new Map([
      [COMPANION_A, ownerA.store],
      [COMPANION_B, ownerB.store],
    ]);
    await provisionFleetContactTopology({ companions, ssoProvider: 'none', accountRoster: [], stores });
    for (const owner of [ownerA, ownerB]) {
      expect(owner.contacts).toHaveLength(1);
      expect(owner.contacts[0]).toMatchObject({ relationshipType: 'ai_companion' });
    }
    await expect(verifyFleetContactTopology({ companions, ssoProvider: 'none', accountRoster: [], stores }))
      .resolves.toMatchObject({ humanContactCount: 0, siblingContactCount: 2 });
    await expect(provisionFleetContactTopology({
      companions, ssoProvider: 'none', accountRoster, stores,
    })).rejects.toThrow(/cannot use a Discord roster/u);
    await expect(provisionFleetContactTopology({
      companions, ssoProvider: 'discord', accountRoster: [], stores,
    })).rejects.toThrow(/rostered owner or admin/u);
  });

  it('names siblings from companions.json and renames only placeholder-named siblings (7frk9)', async () => {
    const placeholder = {
      id: 'sibling-b',
      displayName: 'Companion 22222222',
      trustLevel: 'regular',
      relationshipType: 'ai_companion',
      isMachineIntelligence: true,
      emotionalBaseline: {},
      firstSeen: '2026-07-29T00:00:00.000Z',
      lastSeen: '2026-07-29T00:00:00.000Z',
      channels: [{ channel: 'companion', userId: COMPANION_B, privacyLevel: 'private' }],
    } satisfies Contact;
    const ownerA = fakeStore([placeholder]);
    const ownerB = fakeStore();
    const stores = new Map([
      [COMPANION_A, ownerA.store],
      [COMPANION_B, ownerB.store],
    ]);
    await provisionFleetContactTopology({ companions, ssoProvider: 'none', accountRoster: [], stores });
    expect(ownerA.contacts.find(contact => contact.id === 'sibling-b')?.displayName).toBe('Nova Unit One');
    expect(ownerB.contacts[0]?.displayName).toBe('Selene');

    // A name the companion or an operator chose is kept on the next apply.
    const sibling = ownerA.contacts.find(contact => contact.id === 'sibling-b');
    if (!sibling) throw new Error('missing test sibling');
    sibling.displayName = 'Novi';
    await provisionFleetContactTopology({ companions, ssoProvider: 'none', accountRoster: [], stores });
    expect(sibling.displayName).toBe('Novi');

    await expect(provisionFleetContactTopology({
      companions: [{ companionId: COMPANION_A }, { companionId: COMPANION_B, displayName: 'Nova Unit One' }],
      ssoProvider: 'none', accountRoster: [], stores,
    })).rejects.toThrow(/has no name/u);
  });
});
