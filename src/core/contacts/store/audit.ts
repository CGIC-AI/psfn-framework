import type Database from 'better-sqlite3';
import { CONTACT_MUTATION_AUDIT_FIELDS } from '../types.js';
import type {
  ContactMutationAuditEntry,
  ContactMutationAuditField,
  ContactMutationAuditQuery,
} from '../types.js';
import type { ContactMutationAuditRow } from './domain-types.js';

function normalizeMutationAuditField(value: string): ContactMutationAuditField | undefined {
  return (CONTACT_MUTATION_AUDIT_FIELDS as readonly string[]).includes(value)
    ? value as ContactMutationAuditField
    : undefined;
}

function toMutationAuditEntry(row: ContactMutationAuditRow): ContactMutationAuditEntry | undefined {
  const field = normalizeMutationAuditField(row.field);
  if (!field) return undefined;

  return {
    id: row.id,
    contactId: row.contact_id,
    actor: row.actor,
    field,
    oldValue: row.old_value,
    newValue: row.new_value,
    timestamp: row.timestamp,
  };
}

function normalizeAuditActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed) return 'system:unknown';
  return trimmed.slice(0, 120);
}

export function appendMutationAuditEntry(
  db: Database.Database,
  contactId: string,
  field: ContactMutationAuditField,
  oldValue: string | null,
  newValue: string | null,
  actor?: string,
): void {
  db.prepare(`
    INSERT INTO contact_mutation_audit (
      contact_id,
      actor,
      field,
      old_value,
      new_value,
      timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contactId,
    normalizeAuditActor(actor),
    field,
    oldValue,
    newValue,
    new Date().toISOString(),
  );
}

export function listMutationAuditEntries(
  db: Database.Database,
  query: ContactMutationAuditQuery = {},
): ContactMutationAuditEntry[] {
  const normalizedLimit = Number.isFinite(query.limit)
    ? Math.max(1, Math.min(Math.floor(query.limit ?? 25), 200))
    : 25;
  const contactId = query.contactId?.trim();
  const actor = query.actor?.trim();

  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (contactId) {
    clauses.push('contact_id = ?');
    params.push(contactId);
  }

  if (actor) {
    clauses.push('actor = ?');
    params.push(actor);
  }

  if (query.field) {
    clauses.push('field = ?');
    params.push(query.field);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT id, contact_id, actor, field, old_value, new_value, timestamp
    FROM contact_mutation_audit
    ${whereClause}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(...params, normalizedLimit) as ContactMutationAuditRow[];

  return rows.flatMap((row) => {
    const mapped = toMutationAuditEntry(row);
    return mapped ? [mapped] : [];
  });
}
