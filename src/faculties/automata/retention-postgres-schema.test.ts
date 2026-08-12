import { describe, expect, it } from 'vitest';
import {
  AUTOMATA_RETENTION_POSTGRES_RELATIONS,
  AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS,
} from './retention-postgres-schema.js';

describe('Automata retention Postgres schema', () => {
  it('keeps immutable classifications and permanent append-only receipts', () => {
    const sql = AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS.join('\n');
    expect(AUTOMATA_RETENTION_POSTGRES_RELATIONS).toEqual([
      'automata_session_classifications',
      'automata_retention_audit_events',
    ]);
    expect(sql).toContain('automata_session_classifications_append_only');
    expect(sql).toContain('automata_session_classifications_no_truncate');
    expect(sql).toContain('automata_retention_audit_events_append_only');
    expect(sql).toContain('automata_retention_audit_events_no_truncate');
    expect(sql).toContain('automata_retention_one_purge_receipt_idx');
    expect(sql).not.toMatch(/message|transcript_text|content_json|prompt|response/iu);
  });

  it('rolls back dependent audit history before classifications', () => {
    expect(AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS).toEqual([
      'DROP TABLE IF EXISTS automata_retention_audit_events',
      'DROP TABLE IF EXISTS automata_session_classifications',
      'DROP FUNCTION IF EXISTS reject_automata_retention_history_mutation()',
    ]);
  });
});
