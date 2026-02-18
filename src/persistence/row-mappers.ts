import type { Contact, RelationshipType } from '../contacts/types.js';
import type { PurrMemory, MemoryType, SensitivityLevel, ConsentFlags } from '../memory/types.js';
import type { TrustLevel } from '../trust/types.js';

export interface MemoryRow {
  id: string;
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotional_valence: number;
  salience: number;
  source_ref: string;
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  superseded_by: string | null;
  tags: string;
  sensitivity: string | null;
  consent_flags: string | null;
}

export function mapMemoryRow(row: MemoryRow): PurrMemory {
  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    salience: row.salience,
    sourceRef: row.source_ref,
    extractedAt: row.extracted_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    supersededBy: row.superseded_by ?? undefined,
    tags: JSON.parse(row.tags) as string[],
    sensitivity: (row.sensitivity ?? 'personal') as SensitivityLevel,
    consentFlags: JSON.parse(row.consent_flags ?? '{}') as ConsentFlags,
  };
}

export interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: string;
  first_seen: string;
  last_seen: string;
  notes: string | null;
}

export function mapContactRow(row: ContactRow): Contact {
  return {
    id: row.id,
    discordUserId: row.discord_user_id ?? undefined,
    displayName: row.display_name,
    trustLevel: row.trust_level as TrustLevel,
    relationshipType: row.relationship_type as RelationshipType,
    emotionalBaseline: row.emotional_baseline
      ? JSON.parse(row.emotional_baseline) as Record<string, number>
      : undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    notes: row.notes ?? undefined,
  };
}
