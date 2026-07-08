import { describe, expect, it } from 'vitest';

import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_ENROLLMENT_MIGRATIONS,
  POSTGRES_MEMORY_MIGRATIONS,
} from './migrations.js';

function migrationSql(statements: readonly string[]): string {
  return statements.join('\n');
}

function expectAddColumn(sql: string, table: string, column: string): void {
  expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
}

describe('Postgres live schema migrations', () => {
  it('upgrades existing l2 memory tables with scoped memory columns before indexed use', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    for (const column of [
      'formation_vad',
      'scope_ref_kind',
      'scope_ref_id',
      'scope_ref_label',
      'scope_tags',
      'provenance_refs',
      'retention_class',
      'sensitivity',
      'consent_flags',
      'contact_id',
      'deleted_at',
      'deleted_by',
      'delete_reason',
    ]) {
      expectAddColumn(sql, 'l2_memories', column);
    }

    expect(sql.indexOf('ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_ref_kind')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_ref'),
    );
    expect(sql.indexOf('ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS contact_id')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_l2_memories_contact'),
    );
    expect(sql).toContain("scope_tags JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("sensitivity TEXT NOT NULL DEFAULT 'personal'");
    expect(sql).toContain("consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it('creates the episode message-claim table with a one-live-claim-per-message unique index', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS l01_episode_message_claims');
    expect(sql).toContain('PRIMARY KEY (episode_id, claim_key)');
    expect(sql).toContain("CHECK (status IN ('active', 'transferred'))");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_episode_message_claims_active_key '
      + "ON l01_episode_message_claims(claim_key) WHERE status = 'active';",
    );
    // Claims reference episodes, so the episode table must be created first.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS l01_episodes')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS l01_episode_message_claims'),
    );
  });

  it('upgrades existing contact tables and creates social graph tables for companion DBs', () => {
    const sql = migrationSql(POSTGRES_CONTACT_MIGRATIONS);

    for (const column of [
      'nickname',
      'notes',
      'timezone',
      'channel_identities',
      'conversation_channels',
      'emotional_time_series',
      'is_machine_intelligence',
    ]) {
      expectAddColumn(sql, 'contacts', column);
    }

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_graph_entities');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_relationship_edges');
    expect(sql).toContain('contact_id TEXT UNIQUE');
    expect(sql).toContain('evidence_memory_ids JSONB NOT NULL DEFAULT');
  });

  it('creates the hub-identity enrollment binding + audit tables bound to contacts', () => {
    const sql = migrationSql(POSTGRES_ENROLLMENT_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hub_identity_enrollments');
    expect(sql).toContain('hub_identity_id TEXT PRIMARY KEY');
    expect(sql).toContain('contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hub_identity_enrollment_audit');

    for (const column of ['satellite_id', 'endpoint_id']) {
      expectAddColumn(sql, 'hub_identity_enrollments', column);
    }

    // The binding table must exist before its indexes are created.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS hub_identity_enrollments')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_contact'),
    );

    // No biometric/template column is ever declared — core stores only the handle.
    expect(sql).not.toMatch(/biometric|embedding|template|face_vector/i);
  });
});
