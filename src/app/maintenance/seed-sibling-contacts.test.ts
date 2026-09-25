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
} {
  const resolveChannelIdentity = vi.fn(async () => ({ id: 'contact-1' } as Contact));
  const setMachineIntelligence = vi.fn(async () => true);
  const setTrustLevel = vi.fn(async () => true);
  const updateRelationshipType = vi.fn(async () => true);
  const store = {
    resolveChannelIdentity,
    setMachineIntelligence,
    setTrustLevel,
    updateRelationshipType,
  } as unknown as ContactStorePort;
  return { store, resolveChannelIdentity, setMachineIntelligence, setTrustLevel, updateRelationshipType };
}

describe('seed-sibling-contacts (x5t4)', () => {
  it('mirrors the ICP certification sequence to make a peer ICP-eligible', async () => {
    const fake = createFakeContactStore();

    const contactId = await seedSiblingContact(fake.store, 'peer-companion-id', 'regular');

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
    await seedSiblingContact(fake.store, 'peer-companion-id', 'trusted');
    expect(fake.setTrustLevel).toHaveBeenCalledWith('contact-1', 'trusted', 'operator:seed:sibling-contacts');
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
      { companionId: 'aaaaaaaa-0000-4000-8000-000000000001', postgresSchema: 'companion_alpha', postgresRole: 'companion_alpha_runtime' },
      { companionId: 'bbbbbbbb-0000-4000-8000-000000000002', postgresSchema: 'companion_beta', postgresRole: 'companion_beta_runtime' },
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
