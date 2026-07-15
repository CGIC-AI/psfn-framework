import type { Pool } from 'pg';

import type { TrustLevel } from '../../../system/trust/types.js';

export async function compareAndSetGenericUpsertTrust(
  pool: Pool,
  contactId: string,
  observedTrustLevel: TrustLevel,
  requestedTrustLevel: TrustLevel,
): Promise<boolean> {
  if (observedTrustLevel === requestedTrustLevel) return false;

  // SAFETY: Profile upserts may only mutate a low-tier trust value that still
  // matches their read snapshot. A concurrent explicit promotion or demotion
  // therefore wins in either commit order without serializing profile fields.
  const updated = await pool.query(
    `
      UPDATE contacts
      SET trust_level = $1
      WHERE id = $2
        AND trust_level = $3
        AND trust_level NOT IN ('primary', 'trusted')
      RETURNING id
    `,
    [requestedTrustLevel, contactId, observedTrustLevel],
  );
  return updated.rowCount === 1;
}

export async function compareAndSetExplicitTrust(
  pool: Pool,
  contactId: string,
  observedTrustLevel: TrustLevel,
  requestedTrustLevel: TrustLevel,
): Promise<boolean> {
  // SAFETY: Authorization is evaluated against observedTrustLevel. The CAS
  // prevents that decision from being applied after another trust mutation.
  const updated = await pool.query(
    `
      UPDATE contacts
      SET trust_level = $1
      WHERE id = $2 AND trust_level = $3
      RETURNING id
    `,
    [requestedTrustLevel, contactId, observedTrustLevel],
  );
  return updated.rowCount === 1;
}
