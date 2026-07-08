import {
  inferMemorySourceTypeFromSourceRef,
  normalizeConsentFlags,
  normalizeFormationVAD,
  normalizeMemoryProvenance,
  normalizeMemoryScopeRef,
  normalizeMemorySourceType,
  type PurrMemory,
} from '../types.js';

type PgNumeric = number | string;

export interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: PgNumeric;
  confidence: PgNumeric;
  emotional_valence: PgNumeric;
  formation_vad: unknown;
  salience: PgNumeric;
  source_ref: string;
  source_type: string | null;
  provenance_json: unknown;
  extracted_at: PgNumeric;
  last_accessed: PgNumeric;
  access_count: PgNumeric;
  superseded_by: string | null;
  tags: unknown;
  scope_ref_kind: string | null;
  scope_ref_id: string | null;
  scope_ref_label: string | null;
  scope_tags: unknown;
  provenance_refs: unknown;
  retention_class: PurrMemory['retentionClass'] | null;
  sensitivity: PurrMemory['sensitivity'];
  consent_flags: unknown;
  contact_id: string | null;
  deleted_at: PgNumeric | null;
  deleted_by: string | null;
  delete_reason: string | null;
  embedding: string | null;
}

export interface MemorySchemaTableRow {
  table_name: string;
}

export interface MemorySchemaColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
}

export interface MemoryEmbeddingSearchRow extends MemoryRow {
  similarity: PgNumeric;
}

export interface MemoryDeleteVersionRow {
  delete_id: string;
  memory_id: string;
  snapshot_json: unknown;
  deleted_at: PgNumeric;
  deleted_by: string | null;
  delete_reason: string | null;
  restored_at: PgNumeric | null;
  restored_by: string | null;
}

export interface MemoryAbstractionLinkRow {
  id: string;
  source_memory_id: string;
  abstracted_memory_id: string;
  external_ref: string;
  created_at: number;
  created_by: string | null;
  reason: string | null;
}

export interface MemoryEvolutionLinkRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation: string;
  confidence: number;
  reason: string | null;
  source_ref: string | null;
  source_type: string | null;
  provenance_refs: unknown;
  provenance_json: unknown;
  created_at: number;
}

export interface MemoryLinkRow {
  id1: string;
  id2: string;
  link_type: string;
  created_at: number;
}

export interface MemoryMaintenanceReviewPgRow {
  id: string;
  kind: string;
  status: string;
  subject_memory_id: string;
  candidate_memory_ids: unknown;
  state_json: unknown;
  quarantine_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContactProfileRow {
  contact_id: string;
  summary_text: string;
  source_memory_ids: unknown;
  confidence_score: number;
  novelty_score: number;
  updated_at: number;
}

export interface ScratchpadRow {
  id: string;
  content: string;
  created_at: PgNumeric;
  updated_at: PgNumeric;
}

export interface CountRow {
  count: PgNumeric;
}

export interface AdminMemoryPrivacyAggregateRow {
  active_memory_count: PgNumeric;
  high_sensitivity_count: PgNumeric;
  consent_gated_count: PgNumeric;
  contact_linked_count: PgNumeric;
  scoped_count: PgNumeric;
  preference_count: PgNumeric;
  durable_preference_count: PgNumeric;
}

export interface SensitivityCountRow {
  sensitivity: string | null;
  count: PgNumeric;
}

function decodeJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
}

function decodeJsonObject(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

export function decodeJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function decodeStringArray(value: unknown): string[] {
  return decodeJsonArray(value).map(item => item.trim()).filter(Boolean);
}

export function parsePgNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Invalid PostgreSQL memory row ${field}: expected a finite number`);
}

export function parseOptionalPgNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return parsePgNumber(value, field);
}

export function serializeJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function decodeFormationVAD(value: unknown): PurrMemory['formationVAD'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<NonNullable<PurrMemory['formationVAD']>>;
  if (
    typeof candidate.valence !== 'number'
    || typeof candidate.arousal !== 'number'
    || typeof candidate.dominance !== 'number'
  ) {
    return undefined;
  }
  return normalizeFormationVAD({
    valence: candidate.valence,
    arousal: candidate.arousal,
    dominance: candidate.dominance,
  });
}

export function encodeEmbeddingLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding, value => Number(value)).join(',')}]`;
}

export function decodeEmbedding(value: unknown): Float32Array | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return new Float32Array();
  const parsedValues = inner.split(',').map((entry) => {
    const normalized = entry.trim();
    if (!normalized) return Number.NaN;
    return Number(normalized);
  });
  if (parsedValues.some((entry) => !Number.isFinite(entry))) {
    return undefined;
  }
  return new Float32Array(parsedValues);
}

export function validateEmbeddingDimensions(embedding: Float32Array, expectedDims: number, operation: string): void {
  if (embedding.length !== expectedDims) {
    throw new Error(`PostgreSQL memory embedding ${operation} dimension mismatch: expected ${expectedDims}, got ${embedding.length}`);
  }
}

export function toMemoryRow(memory: PurrMemory, embedding?: Float32Array): MemoryRow {
  return {
    id: memory.id,
    text: memory.text,
    type: memory.type,
    importance: memory.importance,
    confidence: memory.confidence,
    emotional_valence: memory.emotionalValence,
    formation_vad: memory.formationVAD ?? null,
    salience: memory.salience,
    source_ref: memory.sourceRef,
    source_type: normalizeMemorySourceType(
      memory.sourceType,
      inferMemorySourceTypeFromSourceRef(memory.sourceRef),
    ),
    provenance_json: normalizeMemoryProvenance(memory.provenance) ?? {},
    extracted_at: memory.extractedAt,
    last_accessed: memory.lastAccessed,
    access_count: memory.accessCount,
    superseded_by: memory.supersededBy ?? null,
    tags: memory.tags,
    scope_ref_kind: memory.scopeRef?.kind ?? null,
    scope_ref_id: memory.scopeRef?.id ?? null,
    scope_ref_label: memory.scopeRef?.label ?? null,
    scope_tags: memory.scopeTags ?? [],
    provenance_refs: memory.provenanceRefs ?? [],
    retention_class: memory.retentionClass ?? null,
    sensitivity: memory.sensitivity,
    consent_flags: memory.consentFlags ?? {},
    contact_id: memory.contactId ?? null,
    deleted_at: memory.deletedAt ?? null,
    deleted_by: memory.deletedBy ?? null,
    delete_reason: memory.deleteReason ?? null,
    embedding: embedding ? encodeEmbeddingLiteral(embedding) : null,
  };
}

export function fromMemoryRow(row: MemoryRow): PurrMemory {
  const scopeRef = row.scope_ref_kind && row.scope_ref_id
    ? normalizeMemoryScopeRef({
      kind: row.scope_ref_kind as any,
      id: row.scope_ref_id,
      ...(row.scope_ref_label ? { label: row.scope_ref_label } : {}),
    })
    : undefined;
  const deletedAt = parseOptionalPgNumber(row.deleted_at, 'deleted_at');
  const provenance = normalizeMemoryProvenance(decodeJsonRecord(row.provenance_json));
  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: parsePgNumber(row.importance, 'importance'),
    confidence: parsePgNumber(row.confidence, 'confidence'),
    emotionalValence: parsePgNumber(row.emotional_valence, 'emotional_valence'),
    formationVAD: decodeFormationVAD(row.formation_vad),
    salience: parsePgNumber(row.salience, 'salience'),
    sourceRef: row.source_ref,
    sourceType: normalizeMemorySourceType(
      row.source_type,
      inferMemorySourceTypeFromSourceRef(row.source_ref),
    ),
    ...(provenance ? { provenance } : {}),
    extractedAt: parsePgNumber(row.extracted_at, 'extracted_at'),
    lastAccessed: parsePgNumber(row.last_accessed, 'last_accessed'),
    accessCount: parsePgNumber(row.access_count, 'access_count'),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    tags: decodeStringArray(row.tags),
    ...(scopeRef ? { scopeRef } : {}),
    ...(Array.isArray(row.scope_tags) ? { scopeTags: decodeStringArray(row.scope_tags) } : {}),
    ...(Array.isArray(row.provenance_refs) ? { provenanceRefs: decodeStringArray(row.provenance_refs) } : {}),
    ...(row.retention_class ? { retentionClass: row.retention_class } : {}),
    sensitivity: row.sensitivity,
    consentFlags: normalizeConsentFlags(decodeJsonObject(row.consent_flags)),
    ...(row.contact_id ? { contactId: row.contact_id } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
    ...(row.deleted_by ? { deletedBy: row.deleted_by } : {}),
    ...(row.delete_reason ? { deleteReason: row.delete_reason } : {}),
  };
}
