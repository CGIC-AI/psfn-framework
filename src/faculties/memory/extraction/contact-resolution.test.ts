import { fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { Contact } from '../../../core/contacts/types.js';
import { resolveExtractionSourceContactId } from './contact-resolution.js';

const contact: Contact = {
  id: 'contact-alex', displayName: 'Alex', nickname: 'Lex',
  trustLevel: 'trusted', relationshipType: 'friend', firstSeen: '', lastSeen: '',
};

function store(contacts: Contact[] = []) {
  return fromPartial<ContactStorePort>({
    getByChannelIdentity: vi.fn().mockResolvedValue(undefined),
    getByDiscordUserId: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(contacts),
  });
}

describe('extraction contact resolution', () => {
  it.each([
    ['123456789012345678', 'discord'],
    ['discord-voice:123456789012345678', 'discord'],
    [['companion-dm', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'].join(':'), 'companion'],
    [`api:hermes:${'a'.repeat(64)}`, 'api:hermes'],
    ['api:other:session', 'api'],
  ])('uses the canonical identity channel for %s', async (channelId, identityChannel) => {
    const contacts = store();
    vi.mocked(contacts.getByChannelIdentity).mockResolvedValue(contact);
    expect(await resolveExtractionSourceContactId(channelId, { name: 'Transport Name', authorId: 'author-1' }, contacts))
      .toBe(contact.id);
    expect(contacts.getByChannelIdentity).toHaveBeenCalledWith(identityChannel, 'author-1');
  });

  it('resolves bare Discord IDs through the Discord contact field', async () => {
    const contacts = store();
    vi.mocked(contacts.getByDiscordUserId).mockResolvedValue(contact);
    expect(await resolveExtractionSourceContactId('123456789012345678', { name: 'Transport Name', authorId: 'author-1' }, contacts))
      .toBe(contact.id);
  });

  it.each(['Alex', 'Lex'])('matches the %s alias even when a preferred nickname exists', async name => {
    expect(await resolveExtractionSourceContactId('api:session', { name }, store([contact])))
      .toBe(contact.id);
  });

  it('does not guess an unstored bare-name alias from an organization suffix', async () => {
    const tagged = { ...contact, displayName: 'Alex [Observatory]', nickname: undefined };
    expect(await resolveExtractionSourceContactId('api:session', { name: 'Alex' }, store([tagged])))
      .toBeUndefined();
    expect(await resolveExtractionSourceContactId('api:session', { name: 'Alex [Observatory]' }, store([tagged])))
      .toBe(tagged.id);
  });

  it('rejects ambiguous names and excludes archived contacts', async () => {
    const duplicate = { ...contact, id: 'contact-other', displayName: 'Lex', nickname: undefined };
    expect(await resolveExtractionSourceContactId('api:session', { name: 'Lex' }, store([contact, duplicate])))
      .toBeUndefined();
    expect(await resolveExtractionSourceContactId('api:session', { name: 'Alex' }, store([{ ...contact, archivedAt: '2026-01-01' }])))
      .toBeUndefined();
  });
});
