import { describe, expect, it, vi } from 'vitest';
import {
  applySiblingContactSeeding,
  parseSiblingTrust,
  seedSiblingContact,
} from './seed-sibling-contacts.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact } from '../../core/contacts/contact-store-port.js';

function createFakeContactStore(): {
  store: ContactStorePort;
  resolveChannelIdentity: ReturnType<typeof vi.fn>;
  setMachineIntelligence: ReturnType<typeof vi.fn>;
  setTrustLevel: ReturnType<typeof vi.fn>;
  updateRelationshipType: ReturnType<typeof vi.fn>;
  updateIdentityProfile: ReturnType<typeof vi.fn>;
} {
  const resolveChannelIdentity = vi.fn(async (_channel: string, _userId: string, displayName: string) => (
    { id: 'contact-1', displayName } as Contact
  ));
  const updateIdentityProfile = vi.fn(async () => true);
  const setMachineIntelligence = vi.fn(async () => true);
  const setTrustLevel = vi.fn(async () => true);
  const updateRelationshipType = vi.fn(async () => true);
  const store = {
    resolveChannelIdentity,
    setMachineIntelligence,
    setTrustLevel,
    updateRelationshipType,
    updateIdentityProfile,
  } as unknown as ContactStorePort;
  return { store, resolveChannelIdentity, setMachineIntelligence, setTrustLevel, updateRelationshipType, updateIdentityProfile };
}

describe('seed-sibling-contacts (x5t4)', () => {
  it('mirrors the ICP certification sequence to make a peer ICP-eligible', async () => {
    const fake = createFakeContactStore();

    const contactId = await seedSiblingContact(fake.store, { companionId: 'peer-companion-id', displayName: 'Nova Unit One' }, 'regular');

    expect(contactId).toBe('contact-1');
    expect(fake.resolveChannelIdentity).toHaveBeenCalledWith(
      'companion',
      'peer-companion-id',
      expect.stringContaining('Companion peer-com'),
    );
    expect(fake.setMachineIntelligence).toHaveBeenCalledWith('contact-1', true, 'operator:seed:sibling-contacts');
    expect(fake.setTrustLevel).toHaveBeenCalledWith('contact-1', 'regular', 'operator:seed:sibling-contacts');
    expect(fake.updateRelationshipType).toHaveBeenCalledWith('contact-1', 'ai_companion', 'operator:seed:sibling-contacts');
  });

  it('passes an operator-chosen trust level through to the store', async () => {
    const fake = createFakeContactStore();
    await seedSiblingContact(fake.store, { companionId: 'peer-companion-id', displayName: 'Nova Unit One' }, 'trusted');
    expect(fake.setTrustLevel).toHaveBeenCalledWith('contact-1', 'trusted', 'operator:seed:sibling-contacts');
  });

  describe('sibling names (7frk9)', () => {
    const PEER = 'bbbbbbbb-0000-4000-8000-000000000002';

    it('names a new sibling from companions.json displayName, keeping the card name as an alias', async () => {
      const fake = createFakeContactStore();
      await seedSiblingContact(
        fake.store,
        { companionId: PEER, displayName: 'Nova Unit One', characterCardPath: '/cards/vega.json' },
        'regular',
        () => 'Nova',
      );
      expect(fake.updateIdentityProfile).toHaveBeenCalledWith('contact-1', 'Nova Unit One', 'Nova', 'operator:seed:sibling-contacts');
    });

    it('falls back to the character card name', async () => {
      const fake = createFakeContactStore();
      await seedSiblingContact(fake.store, { companionId: PEER, characterCardPath: '/cards/vega.json' }, 'regular', () => 'Nova');
      expect(fake.updateIdentityProfile).toHaveBeenCalledWith('contact-1', 'Nova', undefined, 'operator:seed:sibling-contacts');
    });

    it('fails closed before any write when the sibling has no name', async () => {
      const fake = createFakeContactStore();
      await expect(seedSiblingContact(fake.store, { companionId: PEER }, 'regular')).rejects.toThrow('has no name');
      expect(fake.resolveChannelIdentity).not.toHaveBeenCalled();
    });

    it('renames an existing placeholder-named sibling but never a chosen name', async () => {
      const placeholder = createFakeContactStore();
      placeholder.resolveChannelIdentity.mockResolvedValueOnce({ id: 'contact-1', displayName: 'Companion bbbbbbbb' } as Contact);
      await seedSiblingContact(placeholder.store, { companionId: PEER, displayName: 'Nova Unit One' }, 'regular');
      expect(placeholder.updateIdentityProfile).toHaveBeenCalledWith('contact-1', 'Nova Unit One', undefined, 'operator:seed:sibling-contacts');

      const renamed = createFakeContactStore();
      renamed.resolveChannelIdentity.mockResolvedValueOnce({ id: 'contact-1', displayName: 'Novi', nickname: 'my sibling' } as Contact);
      await seedSiblingContact(renamed.store, { companionId: PEER, displayName: 'Nova Unit One', characterCardPath: '/c' }, 'regular', () => 'Nova');
      expect(renamed.updateIdentityProfile).not.toHaveBeenCalled();
    });
  });

  it('accepts only trust levels at or above the ICP floor', () => {
    expect(parseSiblingTrust('regular')).toBe('regular');
    expect(parseSiblingTrust(' trusted ')).toBe('trusted');
    expect(() => parseSiblingTrust('public')).toThrow('ICP floor');
    expect(() => parseSiblingTrust('primary')).toThrow('regular, trusted');
    expect(() => parseSiblingTrust('nonsense')).toThrow();
  });

  describe('fleet apply (w6f98)', () => {
    const fleet = [
      { companionId: 'aaaaaaaa-0000-4000-8000-000000000001', postgresSchema: 'companion_alpha', postgresRole: 'companion_alpha_runtime', displayName: 'Selene' },
      { companionId: 'bbbbbbbb-0000-4000-8000-000000000002', postgresSchema: 'companion_beta', postgresRole: 'companion_beta_runtime', displayName: 'Nova Unit One' },
    ];

    it("opens each owner's contact store with its companions.json postgresRole", async () => {
      const targets: Array<{ schema: string; role: string }> = [];
      const fakes: ReturnType<typeof createFakeContactStore>[] = [];
      const seeded = await applySiblingContactSeeding({
        databaseUrl: 'postgres://seed@db.invalid/fleet',
        companions: fleet,
        trust: 'regular',
        createStore: async (_url, target) => {
          targets.push(target);
          const fake = createFakeContactStore();
          fakes.push(fake);
          return fake.store;
        },
      });

      expect(targets).toEqual([
        { schema: 'companion_alpha', role: 'companion_alpha_runtime' },
        { schema: 'companion_beta', role: 'companion_beta_runtime' },
      ]);
      expect(seeded).toEqual([
        { owner: fleet[0].companionId, peer: fleet[1].companionId, contactId: 'contact-1' },
        { owner: fleet[1].companionId, peer: fleet[0].companionId, contactId: 'contact-1' },
      ]);
      expect(fakes[0].resolveChannelIdentity).toHaveBeenCalledWith('companion', fleet[1].companionId, expect.any(String));
      expect(fakes[1].resolveChannelIdentity).toHaveBeenCalledWith('companion', fleet[0].companionId, expect.any(String));
    });

    it('fails closed when a fleet entry has no configured role', async () => {
      const createStore = vi.fn();
      await expect(applySiblingContactSeeding({
        databaseUrl: 'postgres://seed@db.invalid/fleet',
        companions: [{ ...fleet[0], postgresRole: ' ' }, fleet[1]],
        trust: 'regular',
        createStore,
      })).rejects.toThrow('postgresRole');
      expect(createStore).not.toHaveBeenCalled();
    });
  });
});
