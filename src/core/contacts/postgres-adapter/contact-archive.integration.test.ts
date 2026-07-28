import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { AdminContactsDataService } from '../../../operator/garden/services/contacts-service.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { createPostgresContactStore } from '../postgres-adapter.js';
import type { ContactStorePort } from '../contact-store-port.js';

// bead psfn-framework-qgqw.1 (adjudication R10.3): contacts are archived, never
// deleted. These regressions run against a real Postgres (never a mock) so the
// additive migration, the released-identity namespace, and the archived-history
// hydration are all exercised end to end.

const TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function freshStore(): Promise<{ store: ContactStorePort; pool: ReturnType<typeof createPostgresPool> }> {
  if (!harness) throw new Error('Postgres test harness unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'contact-archive-test',
    allowExitOnIdle: true,
    max: 8,
  });
  // createPostgresContactStore applies POSTGRES_CONTACT_MIGRATIONS, so a clean
  // store creation IS the assertion that the archived_at migration applies.
  const store = await createPostgresContactStore(database.databaseUrl, 'primary-subject', { pool });
  return { store, pool };
}

describe('contact archive semantics (qgqw.1)', () => {
  it('archives instead of deletes via the port, preserving the row and audit trail', async () => {
    const { store, pool } = await freshStore();
    try {
      const contact = await store.upsert({
        displayName: 'Archivable Person',
        channels: [{ channel: 'discord', userId: 'discord-archivable', privacyLevel: 'invite_only', firstSeen: '', lastSeen: '' }],
      });

      await expect(store.archiveContact(contact.id, 'operator:test')).resolves.toBe(true);

      // Row survives and carries the archive marker.
      const reloaded = await store.getById(contact.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.archivedAt).toBeTruthy();

      // The archive is recorded in the mutation audit trail.
      const audit = await store.listMutationAuditEntries({ contactId: contact.id });
      expect(audit.some(entry => entry.field === 'archived')).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('excludes an archived contact from live resolution while its history stays readable', async () => {
    const { store, pool } = await freshStore();
    try {
      const contact = await store.upsert({
        displayName: 'Vanishing Person',
        channels: [{ channel: 'discord', userId: 'discord-vanishing', privacyLevel: 'invite_only', firstSeen: '', lastSeen: '' }],
      });

      await store.archiveContact(contact.id, 'operator:test');

      // Live channel-identity resolution no longer surfaces the archived contact.
      await expect(store.getByChannelIdentity('discord', 'discord-vanishing')).resolves.toBeUndefined();
      await expect(store.getByDiscordUserId('discord-vanishing')).resolves.toBeUndefined();
      await expect(store.getCanonicalContactKey('discord', 'discord-vanishing')).resolves.toBeUndefined();

      // History remains readable: getById hydrates the snapshotted privacy link.
      const readable = await store.getById(contact.id);
      expect(readable?.archivedAt).toBeTruthy();
      expect(readable?.channels?.some(c => c.channel === 'discord' && c.userId === 'discord-vanishing')).toBe(true);

      // listAll still returns the archived contact for the grayed-out admin view.
      const all = await store.listAll();
      expect(all.some(c => c.id === contact.id && c.archivedAt)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('resolves a recreated / reused platform id to a NEW contact, not the archived one', async () => {
    const { store, pool } = await freshStore();
    try {
      const original = await store.upsert({
        displayName: 'Original Owner',
        channels: [{ channel: 'discord', userId: 'discord-reused-id', privacyLevel: 'invite_only', firstSeen: '', lastSeen: '' }],
      });

      await store.archiveContact(original.id, 'operator:test');

      // Same textual platform id reappears (e.g. a freed handle re-registered):
      // it must mint a fresh contact rather than resurrect the archived one.
      const resolved = await store.resolveChannelIdentity('discord', 'discord-reused-id', 'Brand New Owner');
      expect(resolved.id).not.toBe(original.id);
      expect(resolved.archivedAt).toBeUndefined();

      // The reused id now resolves to the NEW contact (link written, no collision
      // with the archived person's released identity row).
      const liveOwner = await store.getByChannelIdentity('discord', 'discord-reused-id');
      expect(liveOwner?.id).toBe(resolved.id);
      expect(liveOwner?.archivedAt).toBeUndefined();
      expect(liveOwner?.channels?.some(c => c.channel === 'discord' && c.userId === 'discord-reused-id')).toBe(true);

      // The archived original is untouched and still carries its history.
      const archivedStill = await store.getById(original.id);
      expect(archivedStill?.archivedAt).toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  it('never archives the primary contact and is idempotent on re-archive', async () => {
    const { store, pool } = await freshStore();
    try {
      const primary = await store.upsert(
        { displayName: 'Primary', discordUserId: 'primary-subject', trustLevel: 'primary' },
        { actor: 'operator:test' },
      );
      expect(primary.trustLevel).toBe('primary');
      await expect(store.archiveContact(primary.id, 'operator:test')).resolves.toBe(false);
      expect((await store.getById(primary.id))?.archivedAt).toBeUndefined();

      const regular = await store.upsert({ displayName: 'Regular' });
      await expect(store.archiveContact(regular.id, 'operator:test')).resolves.toBe(true);
      // Re-archiving is idempotent.
      await expect(store.archiveContact(regular.id, 'operator:test')).resolves.toBe(true);

      // Missing contact returns false.
      await expect(store.archiveContact('does-not-exist', 'operator:test')).resolves.toBe(false);
    } finally {
      await pool.end();
    }
  });

  it('archives through the Garden contact route/action instead of deleting', async () => {
    const { store, pool } = await freshStore();
    try {
      const contact = await store.upsert({
        displayName: 'Garden Archivable',
        channels: [{ channel: 'discord', userId: 'discord-garden', privacyLevel: 'invite_only', firstSeen: '', lastSeen: '' }],
      });

      const service = new AdminContactsDataService({
        contactStore: store,
        memoryStore: {} as unknown as MemoryStorePort,
        sessionStore: {} as unknown as SessionStore,
      });

      const result = await service.archiveContact(contact.id);
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/archived/i);

      // Route archived (not deleted): the row is still readable.
      expect((await store.getById(contact.id))?.archivedAt).toBeTruthy();
      // And it is gone from live resolution.
      await expect(store.getByChannelIdentity('discord', 'discord-garden')).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
