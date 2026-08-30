import { describe, expect, it, vi } from 'vitest';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import { EIDOVERSE_CONTACT_CHANNEL } from './types.js';

describe('Eidoverse contact channel', () => {
  it('uses the stable eidoverse channel token', () => {
    expect(EIDOVERSE_CONTACT_CHANNEL).toBe('eidoverse');
  });

  it('links a participant id to an existing Discord contact without creating a contact or presence row', async () => {
    const { pool, store } = await createTestPostgresContactStore();
    const sharedSubject = 'participant-aid1-subject';
    const contact = await store.upsert({
      displayName: 'Existing visitor',
      discordUserId: sharedSubject,
      trustLevel: 'regular',
    });
    const contactCountBeforeLink = pool.contacts.size;
    const query = vi.spyOn(pool, 'query');
    query.mockClear();

    const result = await store.linkChannelIdentity(
      contact.id,
      EIDOVERSE_CONTACT_CHANNEL,
      sharedSubject,
      undefined,
      'operator:eidoverse-enrollment',
    );

    expect(result).toBe('linked');
    expect(pool.contacts.size).toBe(contactCountBeforeLink);
    expect(await store.getByChannelIdentity('discord', sharedSubject)).toMatchObject({ id: contact.id });
    expect(await store.getByChannelIdentity(EIDOVERSE_CONTACT_CHANNEL, sharedSubject)).toMatchObject({
      id: contact.id,
      trustLevel: 'regular',
    });
    expect((await store.getById(contact.id))?.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'discord', userId: sharedSubject }),
      expect.objectContaining({ channel: EIDOVERSE_CONTACT_CHANNEL, userId: sharedSubject }),
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes('companion_presence'))).toBe(false);
  });
});
