/**
 * Biographical Profile projection tables (psfn-framework-o61vb.2).
 *
 * These are rebuildable, append-only authorization-evidence rows, intentionally
 * separate from the general memory/contact CRUD schema (see the precedent set
 * by the fleet_auth contact-authority lifecycle rows). The full claim and grant
 * envelopes are stored as JSONB; indexed columns support subject, kind, status,
 * and digest lookups without hydrating the envelope. Claims are never deleted:
 * supersession and revocation update `status` (and the cached
 * effective_sensitivity inside `claim_json`) and preserve history. Legacy
 * `contact_profiles` cutover criteria are recorded in `docs/specifications.md`
 * (Live Alpha Migration Boundary).
 */
export const POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS biographical_claims (
    id TEXT PRIMARY KEY,
    claim_digest TEXT NOT NULL,
    source_set_digest TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_version BIGINT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    effective_sensitivity TEXT NOT NULL,
    supersedes_claim_id TEXT,
    claim_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT biographical_claims_claim_digest_check CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT biographical_claims_source_set_digest_check CHECK (source_set_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT biographical_claims_schema_version_check CHECK (schema_version = 1),
    CONSTRAINT biographical_claims_subject_kind_check CHECK (subject_kind IN ('companion', 'contact')),
    CONSTRAINT biographical_claims_subject_version_check CHECK (subject_version >= 1),
    CONSTRAINT biographical_claims_kind_check CHECK (kind IN ('name', 'nickname', 'relationship')),
    CONSTRAINT biographical_claims_status_check CHECK (status IN ('candidate', 'active', 'contested', 'superseded', 'revoked')),
    CONSTRAINT biographical_claims_effective_sensitivity_check CHECK (effective_sensitivity IN ('public', 'personal', 'intimate', 'confidential'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_biographical_claims_subject ON biographical_claims(subject_kind, subject_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_biographical_claims_kind ON biographical_claims(subject_kind, subject_id, kind, status);`,
  `CREATE INDEX IF NOT EXISTS idx_biographical_claims_digests ON biographical_claims(claim_digest, source_set_digest);`,
  `CREATE INDEX IF NOT EXISTS idx_biographical_claims_supersedes ON biographical_claims(supersedes_claim_id);`,
  `
  CREATE TABLE IF NOT EXISTS biographical_grants (
    id TEXT PRIMARY KEY,
    claim_digest TEXT NOT NULL,
    source_set_digest TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    policy_version INTEGER NOT NULL,
    granted_sensitivity TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    grant_json JSONB NOT NULL,
    CONSTRAINT biographical_grants_claim_digest_check CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT biographical_grants_source_set_digest_check CHECK (source_set_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT biographical_grants_schema_version_check CHECK (schema_version = 1),
    CONSTRAINT biographical_grants_policy_version_check CHECK (policy_version = 1),
    CONSTRAINT biographical_grants_granted_sensitivity_check CHECK (granted_sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
    CONSTRAINT biographical_grants_expiry_order_check CHECK (expires_at IS NULL OR expires_at > granted_at)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_biographical_grants_digests ON biographical_grants(claim_digest, source_set_digest);`,
];
