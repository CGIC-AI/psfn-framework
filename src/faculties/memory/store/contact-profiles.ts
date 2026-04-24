import type Database from 'better-sqlite3';
import type { ContactProfileArtifact } from '../memory-store-port.js';
import type { ContactProfileRow } from './types.js';

function mapContactProfileRow(row: ContactProfileRow): ContactProfileArtifact {
  let sourceMemoryIds: string[] = [];
  try {
    sourceMemoryIds = JSON.parse(row.source_memory_ids) as string[];
  } catch {
    sourceMemoryIds = [];
  }

  return {
    contactId: row.contact_id,
    summary: row.summary_text,
    sourceMemoryIds,
    confidenceScore: row.confidence_score,
    noveltyScore: row.novelty_score,
    updatedAt: row.updated_at,
  };
}

export function upsertContactProfile(
  db: Database.Database,
  profile: ContactProfileArtifact,
): void {
  db.prepare(`
    INSERT INTO contact_profiles (
      contact_id,
      summary_text,
      source_memory_ids,
      confidence_score,
      novelty_score,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET
      summary_text = excluded.summary_text,
      source_memory_ids = excluded.source_memory_ids,
      confidence_score = excluded.confidence_score,
      novelty_score = excluded.novelty_score,
      updated_at = excluded.updated_at
  `).run(
    profile.contactId,
    profile.summary,
    JSON.stringify(profile.sourceMemoryIds),
    profile.confidenceScore,
    profile.noveltyScore,
    profile.updatedAt,
  );
}

export function getContactProfile(
  db: Database.Database,
  contactId: string,
): ContactProfileArtifact | undefined {
  const row = db.prepare(`
    SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
    FROM contact_profiles
    WHERE contact_id = ?
    LIMIT 1
  `).get(contactId) as ContactProfileRow | undefined;
  if (!row) return undefined;
  return mapContactProfileRow(row);
}

export function listContactProfiles(db: Database.Database): ContactProfileArtifact[] {
  const rows = db.prepare(`
    SELECT contact_id, summary_text, source_memory_ids, confidence_score, novelty_score, updated_at
    FROM contact_profiles
    ORDER BY updated_at DESC
  `).all() as ContactProfileRow[];

  return rows.map(mapContactProfileRow);
}
