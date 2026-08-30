import { describe, expect, it, vi } from 'vitest';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import type { ContactIdentityLinkOptions } from './types.js';
import { EIDOVERSE_CONTACT_CHANNEL } from './types.js';

describe('contact identity introduction provenance', () => {
  it('round-trips first-introduction evidence without affecting trust, privacy, or companion presence', async () => {
    const { pool, store } = await createTestPostgresContactStore();
    const contact = await store.upsert({
      displayName: 'World visitor',
      trustLevel: 'public',
    });
    const query = vi.spyOn(pool, 'query');
    query.mockClear();

    await expect(store.linkChannelIdentity(
      contact.id,
      EIDOVERSE_CONTACT_CHANNEL,
      'participant-aid1-world-visitor',
      {
        introducedAtPlaceId: '  place.central-plaza  ',
        introducedAtWorld: '  anima-research/eidoverse  ',
        introducedVia: '  EIDOVERSE  ',
      },
      'operator:eidoverse-enrollment',
    )).resolves.toBe('linked');

    const persisted = await store.getById(contact.id);
    expect(persisted?.trustLevel).toBe('public');
    expect(persisted?.channels).toContainEqual(expect.objectContaining({
      channel: EIDOVERSE_CONTACT_CHANNEL,
      userId: 'participant-aid1-world-visitor',
      privacyLevel: 'invite_only',
      introducedAtPlaceId: 'place.central-plaza',
      introducedAtWorld: 'anima-research/eidoverse',
      introducedVia: EIDOVERSE_CONTACT_CHANNEL,
    }));
    expect(pool.contactChannelIds.get('eidoverse::participant-aid1-world-visitor')).toMatchObject({
      introduced_at_place_id: 'place.central-plaza',
      introduced_at_world: 'anima-research/eidoverse',
      introduced_via: EIDOVERSE_CONTACT_CHANNEL,
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('companion_presence'))).toBe(false);

    await expect(store.linkChannelIdentity(
      contact.id,
      EIDOVERSE_CONTACT_CHANNEL,
      'participant-aid1-world-visitor',
      {
        introducedAtPlaceId: 'place.later-sighting',
        introducedAtWorld: 'different-world',
        introducedVia: 'discord',
      },
    )).resolves.toBe('already_linked');
    expect((await store.getById(contact.id))?.channels).toContainEqual(expect.objectContaining({
      introducedAtPlaceId: 'place.central-plaza',
      introducedAtWorld: 'anima-research/eidoverse',
      introducedVia: EIDOVERSE_CONTACT_CHANNEL,
    }));
  });

  it('keeps existing identity-link reads byte-compatible when provenance is absent', async () => {
    const { store } = await createTestPostgresContactStore();
    const contact = await store.upsert({ displayName: 'Existing contact' });

    await expect(store.linkChannelIdentity(contact.id, 'telegram', 'existing-user'))
      .resolves.toBe('linked');

    const link = (await store.getById(contact.id))?.channels
      ?.find(candidate => candidate.channel === 'telegram');
    expect(link).toEqual({
      channel: 'telegram',
      userId: 'existing-user',
      privacyLevel: 'invite_only',
      firstSeen: expect.any(String),
      lastSeen: expect.any(String),
    });
    expect(link).not.toHaveProperty('introducedAtPlaceId');
    expect(link).not.toHaveProperty('introducedAtWorld');
    expect(link).not.toHaveProperty('introducedVia');
  });

  it('retains introduction evidence in an archived contact identity snapshot', async () => {
    const { store } = await createTestPostgresContactStore();
    const contact = await store.upsert({ displayName: 'Archived world visitor' });
    await store.linkChannelIdentity(
      contact.id,
      EIDOVERSE_CONTACT_CHANNEL,
      'participant-aid1-archived',
      {
        introducedAtPlaceId: 'place.archive-origin',
        introducedAtWorld: 'eidoverse-archive-world',
        introducedVia: EIDOVERSE_CONTACT_CHANNEL,
      },
    );

    await expect(store.archiveContact(contact.id, 'operator:test')).resolves.toBe(true);

    expect((await store.getById(contact.id))?.channels).toContainEqual(expect.objectContaining({
      channel: EIDOVERSE_CONTACT_CHANNEL,
      userId: 'participant-aid1-archived',
      introducedAtPlaceId: 'place.archive-origin',
      introducedAtWorld: 'eidoverse-archive-world',
      introducedVia: EIDOVERSE_CONTACT_CHANNEL,
    }));
  });

  it.each([
    [{ introducedAtPlaceId: '  ' }, 'introducedAtPlaceId'],
    [{ introducedAtWorld: 42 }, 'introducedAtWorld'],
    [{ introducedVia: '' }, 'introducedVia'],
    [{ introducedAtUniverse: 'unknown-key' }, 'introducedAtUniverse'],
  ] as const)('rejects malformed or unknown provenance option %s', async (options, field) => {
    const { store } = await createTestPostgresContactStore();
    const contact = await store.upsert({ displayName: 'Strict provenance' });

    await expect(store.linkChannelIdentity(
      contact.id,
      EIDOVERSE_CONTACT_CHANNEL,
      `strict-${field}`,
      options as unknown as ContactIdentityLinkOptions,
    )).rejects.toThrow(field);
  });
});
