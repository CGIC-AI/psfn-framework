import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresContactStore } from './store.js';

const SUBJECT_ID = '123456789012345679';
const VERIFICATION_ID = '00000000-0000-4000-8000-000000000201';

function row(overrides: Record<string, unknown> = {}) {
  return {
    contact_id: 'contact-one',
    contact_authority_version: '7',
    contact_lifecycle_state: 'live',
    contact_restore_state: 'live',
    identity_version: '4',
    ownership_state: 'verified',
    ownership_restore_state: 'live',
    verification_id: VERIFICATION_ID,
    source_channel: 'discord',
    source_user_id: SUBJECT_ID,
    target_channel: 'discord',
    target_user_id: SUBJECT_ID,
    verification_status: 'verified',
    verified_at: '2026-07-16T22:00:00.000Z',
    ...overrides,
  };
}

function storeWithRows(rows: ReturnType<typeof row>[]) {
  const query = vi.fn(async () => ({ rowCount: rows.length, rows }));
  return {
    query,
    store: new PostgresContactStore({ query } as unknown as Pool),
  };
}

describe('exact Discord contact-authority snapshot', () => {
  it('returns only the exact live verified ownership tuple and current versions', async () => {
    const { store, query } = storeWithRows([row()]);
    await expect(store.readVerifiedDiscordContactAuthority(
      'contact-one',
      SUBJECT_ID,
    )).resolves.toEqual({
      schemaVersion: 1,
      contactId: 'contact-one',
      channel: 'discord',
      providerSubjectId: SUBJECT_ID,
      identityVersion: 4,
      verificationId: VERIFICATION_ID,
      verificationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      contactAuthorityVersion: 7,
      ownershipState: 'verified',
      restoreState: 'live',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      "ownership.channel = 'discord'",
    ), ['contact-one', SUBJECT_ID]);
  });

  it.each([
    { ownership_state: 'suspended' },
    { contact_restore_state: 'quarantined' },
    { ownership_restore_state: 'quarantined' },
    { verification_status: 'pending' },
    { verified_at: null },
  ])('fails closed for non-live ownership %#', async (overrides) => {
    const { store } = storeWithRows([row(overrides)]);
    await expect(store.readVerifiedDiscordContactAuthority(
      'contact-one',
      SUBJECT_ID,
    )).resolves.toBeUndefined();
  });

  it('fails closed when the database returns an ambiguous duplicate tuple', async () => {
    const { store } = storeWithRows([row(), row()]);
    await expect(store.readVerifiedDiscordContactAuthority(
      'contact-one',
      SUBJECT_ID,
    )).resolves.toBeUndefined();
  });
});
