import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresContactStore } from './postgres-adapter.js';
import { FakePostgresPool } from '../../test-support/fake-postgres-contact-pool.js';

describe('PostgresContactStore', () => {
  it('round-trips contact identity and social graph data', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-discord',
      channels: [{
        channel: 'telegram',
        userId: 'alice-telegram',
        privacyLevel: 'private',
        firstSeen: '2026-03-28T00:00:00.000Z',
        lastSeen: '2026-03-28T00:00:00.000Z',
      }],
    });

    expect(contact.displayName).toBe('Alice');
    expect(contact.discordUserId).toBe('alice-discord');
    expect(await store.getByChannelIdentity('telegram', 'alice-telegram')).toMatchObject({
      id: contact.id,
      displayName: 'Alice',
    });
    expect(await store.getByDiscordUserId('alice-discord')).toMatchObject({
      id: contact.id,
      displayName: 'Alice',
    });
    expect(await store.getSocialGraphEntityByContactId(contact.id)).toMatchObject({
      id: `contact:${contact.id}`,
      contactId: contact.id,
      source: 'contact',
    });
  });

  it('preserves, updates, and clears contact timezone metadata', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Timezone Contact',
      discordUserId: 'timezone-discord',
      timezone: 'America/New_York',
    });

    expect(contact.timezone).toBe('America/New_York');
    await expect(store.getByDiscordUserId('timezone-discord')).resolves.toMatchObject({
      id: contact.id,
      timezone: 'America/New_York',
    });

    const preserved = await store.upsert({
      displayName: 'Timezone Contact Renamed',
      discordUserId: 'timezone-discord',
    });
    expect(preserved.timezone).toBe('America/New_York');

    const changed = await store.upsert({
      displayName: 'Timezone Contact Renamed',
      discordUserId: 'timezone-discord',
      timezone: 'Asia/Tokyo',
    }, { actor: 'admin:api' });
    expect(changed.timezone).toBe('Asia/Tokyo');

    const cleared = await store.upsert({
      displayName: 'Timezone Contact Renamed',
      discordUserId: 'timezone-discord',
      timezone: undefined,
    }, { actor: 'admin:api' });
    expect(cleared.timezone).toBeUndefined();

    expect(pool.contactMutationAudit.filter(entry => entry.field === 'timezone')).toEqual([
      expect.objectContaining({
        contact_id: contact.id,
        actor: 'admin:api',
        old_value: 'America/New_York',
        new_value: 'Asia/Tokyo',
      }),
      expect.objectContaining({
        contact_id: contact.id,
        actor: 'admin:api',
        old_value: 'Asia/Tokyo',
        new_value: null,
      }),
    ]);
  });

  it('does not overwrite a relationship changed while an unrelated upsert is in flight', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({ displayName: 'Concurrent Profile', relationshipType: 'friend' });
    pool.beforeNextContactProfileUpdate = (row) => {
      row.relationship_type = 'family';
    };

    const updated = await store.upsert({
      id: contact.id,
      displayName: 'Concurrent Profile Renamed',
    });

    expect(updated.displayName).toBe('Concurrent Profile Renamed');
    expect(updated.relationshipType).toBe('family');
  });

  it('keeps primary trust independent from relationship on an unrelated upsert', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({
      displayName: 'Primary Relationship',
      discordUserId: 'primary-user-123',
      relationshipType: 'acquaintance',
    });

    const updated = await store.upsert({
      id: contact.id,
      displayName: 'Primary Relationship Renamed',
    });

    expect(updated.trustLevel).toBe('primary');
    expect(updated.relationshipType).toBe('acquaintance');
  });

  it('audits an operator-authorized relationship assignment through upsert', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({ displayName: 'Upsert Relationship Audit', relationshipType: 'friend' });

    const updated = await store.upsert({
      id: contact.id,
      displayName: contact.displayName,
      relationshipType: 'family',
    }, { actor: 'operator:test' });

    expect(updated.relationshipType).toBe('family');
    expect(pool.contactMutationAudit.filter(entry => entry.field === 'relationship_type')).toEqual([
      expect.objectContaining({
        contact_id: contact.id,
        actor: 'operator:test',
        old_value: 'friend',
        new_value: 'family',
      }),
    ]);
  });

  it('rolls back an explicit upsert relationship assignment when audit insertion fails', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({ displayName: 'Upsert Relationship Rollback', relationshipType: 'friend' });
    pool.failNextMutationAudit = true;

    await expect(store.upsert({
      id: contact.id,
      displayName: contact.displayName,
      relationshipType: 'family',
    }, { actor: 'operator:test' })).rejects.toThrow('forced mutation audit failure');

    await expect(store.getById(contact.id)).resolves.toMatchObject({ relationshipType: 'friend' });
    expect(pool.contactMutationAudit).toEqual([]);
  });

  it('creates and verifies a contact identity link challenge', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-discord',
    });

    const challenge = await store.createIdentityLinkChallenge({
      contactId: contact.id,
      sourceChannel: 'discord',
      sourceUserId: 'alice-discord',
      targetChannel: 'api',
      targetUserId: 'alice-api',
      ttlMs: 5 * 60_000,
    });

    expect(challenge.status).toBe('challenge_created');
    expect(challenge.verification.status).toBe('pending');

    const verified = await store.verifyIdentityLinkChallenge({
      contactId: contact.id,
      sourceChannel: 'discord',
      sourceUserId: 'alice-discord',
      targetChannel: 'api',
      targetUserId: 'alice-api',
      nonce: challenge.verification.nonce,
      expiresAt: challenge.verification.expiresAt,
      signature: challenge.verification.signature,
      privacyLevel: 'private',
    });

    expect(verified.status).toBe('linked');
    expect(verified.verification.status).toBe('verified');
    expect(await store.getByChannelIdentity('api', 'alice-api')).toMatchObject({
      id: contact.id,
    });
  });

  it('records and returns a bounded emotional time series per contact', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Ari',
      discordUserId: 'ari-discord',
    });

    expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([]);

    await store.updateEmotionalBaseline(contact.id, {
      valence: 0.15,
      confidence: 0.75,
      observedAtMs: 1_000,
    });
    await store.updateEmotionalBaseline(contact.id, {
      valence: -0.55,
      confidence: 0.65,
      observedAtMs: 2_000,
    });

    expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([
      { valence: 0.15, confidence: 0.75, observedAtMs: 1_000 },
      { valence: -0.55, confidence: 0.65, observedAtMs: 2_000 },
    ]);
    expect(await store.getEmotionalTimeSeries(contact.id, 1)).toEqual([
      { valence: -0.55, confidence: 0.65, observedAtMs: 2_000 },
    ]);
  });

  it('atomically compare-and-sets relationships and records the approved mutation', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({ displayName: 'Relationship CAS', relationshipType: 'friend' });

    await expect(store.compareAndSetRelationshipType(
      contact.id,
      'acquaintance',
      'family',
      'operator:confirmation-queue',
    )).resolves.toBe(false);
    await expect(store.compareAndSetRelationshipType(
      contact.id,
      'friend',
      'family',
      'operator:confirmation-queue',
    )).resolves.toBe(true);

    await expect(store.getById(contact.id)).resolves.toMatchObject({ relationshipType: 'family' });
    expect(pool.contactMutationAudit).toEqual([
      expect.objectContaining({
        contact_id: contact.id,
        actor: 'operator:confirmation-queue',
        field: 'relationship_type',
        old_value: 'friend',
        new_value: 'family',
      }),
    ]);
  });

  it('rolls back a relationship compare-and-set when its audit insert fails', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });
    const contact = await store.upsert({ displayName: 'Relationship Rollback', relationshipType: 'friend' });
    pool.failNextMutationAudit = true;

    await expect(store.compareAndSetRelationshipType(
      contact.id,
      'friend',
      'family',
      'operator:confirmation-queue',
    )).rejects.toThrow('forced mutation audit failure');
    await expect(store.getById(contact.id)).resolves.toMatchObject({ relationshipType: 'friend' });
    expect(pool.contactMutationAudit).toEqual([]);
  });
});
