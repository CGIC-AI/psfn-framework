import type { Pool, PoolClient } from 'pg';

import type { TrustLevel } from '../../../system/trust/types.js';
import { normalizeTrustLevel } from './mapping.js';

export interface ContactTrustSnapshot {
  trustLevel: TrustLevel;
  version: string;
}

export async function loadContactTrustSnapshot(
  pool: Pool,
  contactId: string,
): Promise<ContactTrustSnapshot | undefined> {
  const result = await pool.query<{ trust_level: string; trust_version: string }>(
    `
      SELECT trust_level, trust_version::text AS trust_version
      FROM contacts
      WHERE id = $1
      LIMIT 1
    `,
    [contactId],
  );
  if (result.rowCount !== 1) return undefined;
  const row = result.rows[0];
  return {
    trustLevel: normalizeTrustLevel(row.trust_level),
    version: row.trust_version,
  };
}

export async function compareAndSetGenericUpsertTrust(
  queryable: Pool | PoolClient,
  contactId: string,
  observed: ContactTrustSnapshot,
  requestedTrustLevel: TrustLevel,
): Promise<boolean> {
  if (observed.trustLevel === requestedTrustLevel) return false;

  // SAFETY: Profile upserts may only mutate a low-tier trust value that still
  // matches their read snapshot. A concurrent explicit promotion or demotion
  // therefore wins in either commit order without serializing profile fields.
  const updated = await queryable.query(
    `
      UPDATE contacts
      SET trust_level = $1,
          trust_version = trust_version + 1
      WHERE id = $2
        AND trust_level = $3
        AND trust_version = $4
        AND trust_level NOT IN ('primary', 'trusted')
      RETURNING id
    `,
    [requestedTrustLevel, contactId, observed.trustLevel, observed.version],
  );
  return updated.rowCount === 1;
}

export async function compareAndSetExplicitTrust(
  queryable: Pool | PoolClient,
  contactId: string,
  observed: ContactTrustSnapshot,
  requestedTrustLevel: TrustLevel,
): Promise<boolean> {
  // SAFETY: Authorization is evaluated against the observed trust snapshot. The CAS
  // prevents that decision from being applied after another trust mutation.
  const updated = await queryable.query(
    `
      UPDATE contacts
      SET trust_level = $1,
          trust_version = trust_version + 1
      WHERE id = $2
        AND trust_level = $3
        AND trust_version = $4
      RETURNING id
    `,
    [requestedTrustLevel, contactId, observed.trustLevel, observed.version],
  );
  return updated.rowCount === 1;
}
