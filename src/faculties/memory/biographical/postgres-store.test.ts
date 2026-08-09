import { describe, expect, it } from 'vitest';

import { POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS } from '../../../persistence/postgres/biographical-profile-migrations.js';

const sql = POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS.join('\n');

describe('POSTGRES_BIOGRAPHICAL_PROFILE_MIGRATIONS', () => {
  it('creates append-only claim and grant tables with no DELETE paths', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS biographical_claims');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS biographical_grants');
    // Append-only: migrations never drop or delete rows.
    expect(sql).not.toMatch(/DELETE\s+FROM\s+biographical_/i);
    expect(sql).not.toMatch(/DROP\s+TABLE\s+biographical_/i);
  });

  it('pins the supported claim schema version and rejects others', () => {
    expect(sql).toContain('CONSTRAINT biographical_claims_schema_version_check CHECK (schema_version = 1)');
  });

  it('enforces the closed claim-kind registry at the database boundary', () => {
    expect(sql).toContain(
      "CONSTRAINT biographical_claims_kind_check CHECK (kind IN ('name', 'nickname', 'relationship'))",
    );
  });

  it('enforces the closed status, subject-kind, and sensitivity vocabularies', () => {
    expect(sql).toContain(
      "CONSTRAINT biographical_claims_subject_kind_check CHECK (subject_kind IN ('companion', 'contact'))",
    );
    expect(sql).toContain(
      "CONSTRAINT biographical_claims_status_check CHECK (status IN ('candidate', 'active', 'contested', 'superseded', 'revoked'))",
    );
    expect(sql).toContain(
      "CONSTRAINT biographical_claims_effective_sensitivity_check CHECK (effective_sensitivity IN ('public', 'personal', 'intimate', 'confidential'))",
    );
  });

  it('requires 64-hex digests on claims and grants (exact digest binding)', () => {
    expect(sql).toContain(
      "CONSTRAINT biographical_claims_claim_digest_check CHECK (claim_digest ~ '^[0-9a-f]{64}$')",
    );
    expect(sql).toContain(
      "CONSTRAINT biographical_grants_claim_digest_check CHECK (claim_digest ~ '^[0-9a-f]{64}$')",
    );
    expect(sql).toContain(
      'CONSTRAINT biographical_grants_expiry_order_check CHECK (expires_at IS NULL OR expires_at > granted_at)',
    );
  });

  it('indexes subject, kind, digest, and supersession lookups', () => {
    expect(sql).toContain('idx_biographical_claims_subject');
    expect(sql).toContain('idx_biographical_claims_kind');
    expect(sql).toContain('idx_biographical_claims_digests');
    expect(sql).toContain('idx_biographical_claims_supersedes');
    expect(sql).toContain('idx_biographical_grants_digests');
  });
});
