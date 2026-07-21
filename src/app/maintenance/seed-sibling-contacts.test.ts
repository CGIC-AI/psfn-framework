import { describe, expect, it, vi } from 'vitest';
import { parseSiblingTrust, seedSiblingContact } from './seed-sibling-contacts.js';
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
});
