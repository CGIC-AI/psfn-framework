import { describe, expect, it } from 'vitest';

import {
  POSTGRES_CONTACT_MIGRATIONS,
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

  it('upgrades existing contact tables and creates social graph tables for companion DBs', () => {
    const sql = migrationSql(POSTGRES_CONTACT_MIGRATIONS);

    for (const column of [
      'nickname',
      'notes',
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
});
