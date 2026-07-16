import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  withPostgresClient,
} from '../postgres.js';

export interface ContactLifecycleRestorePostgresOptions {
  databaseUrl: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Restored companion contact authority is evidence, not live authority. Every
 * restored contact, verified ownership row, intent, and target lock remains
 * quarantined until an explicit current-runtime reapproval flow replaces it.
 */
export async function quarantineRestoredContactLifecycleAuthority(
  postgres: ContactLifecycleRestorePostgresOptions,
  schemas: readonly string[],
): Promise<void> {
  const pool = createPostgresPool(postgres.databaseUrl, {
    applicationName: 'fleet-restore-contact-authority-quarantine',
    allowExitOnIdle: true,
    max: 1,
  });
  let failure: unknown;
  try {
    await withPostgresClient(pool, async (client) => {
      for (const rawSchema of schemas) {
        const schema = assertValidPostgresSchemaName(rawSchema);
        const tables = await client.query<{
          contacts: string | null;
          ownerships: string | null;
          intents: string | null;
          locks: string | null;
        }>(`
          SELECT to_regclass($1)::text AS contacts,
                 to_regclass($2)::text AS ownerships,
                 to_regclass($3)::text AS intents,
                 to_regclass($4)::text AS locks
        `, [
          `${schema}.contacts`,
          `${schema}.contact_channel_ids`,
          `${schema}.contact_lifecycle_intents`,
          `${schema}.contact_lifecycle_target_locks`,
        ]);
        const state = tables.rows.at(0);
        const present = state
          ? [state.contacts, state.ownerships, state.intents, state.locks].filter(Boolean).length
          : 0;
        if (present === 0) continue;
        if (present !== 4) {
          throw new Error(`Restored companion schema ${schema} has incomplete contact authority state`);
        }
        const qualified = quoteIdentifier(schema);
        await client.query(`SET LOCAL search_path TO ${qualified}, public`);
        await client.query(`
          UPDATE ${qualified}.contact_channel_ids
          SET ownership_state = 'quarantined', restore_state = 'quarantined'
          WHERE ownership_state = 'verified' OR restore_state = 'live'
        `);
        await client.query(`
          UPDATE ${qualified}.contacts
          SET contact_lifecycle_state = 'quarantined',
              contact_restore_state = 'quarantined',
              contact_authority_version = contact_authority_version + 1
        `);
        await client.query(`
          UPDATE ${qualified}.contact_lifecycle_intents
          SET phase = 'quarantined', reason = 'restore_quarantine',
              restore_state = 'quarantined', lease_owner = NULL,
              lease_expires_at = NULL, updated_at = clock_timestamp()
        `);
        await client.query(`
          UPDATE ${qualified}.contact_lifecycle_target_locks
          SET lock_state = 'quarantined', updated_at = clock_timestamp()
          WHERE lock_state = 'active'
        `);
      }
    });
  } catch (error) {
    failure = error;
  }
  try {
    await pool.end();
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError(
        [failure, cleanupError],
        'Contact authority restore quarantine failed and its Postgres pool could not close',
      );
    }
    throw cleanupError;
  }
  if (failure) throw failure;
}
