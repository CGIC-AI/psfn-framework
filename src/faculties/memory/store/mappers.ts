import type {
  MemoryAbstractionLink,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryLink,
  MemoryPatchEvent,
  ScratchpadEntry,
} from '../memory-store-port.js';
import { MEMORY_EVOLUTION_RELATIONS } from '../memory-store-port.js';
import {
  inferMemorySourceTypeFromSourceRef,
  normalizeConsentFlags,
  normalizeFormationVAD,
  normalizeMemoryProvenance,
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  normalizeMemorySourceType,
  type ConsentFlags,
  type MemoryFormationVAD,
  type MemoryProvenance,
  type MemoryScopeRef,
  type PurrMemory,
  type SensitivityLevel,
} from '../types.js';
import type {
  MemoryAbstractionLinkRow,
  MemoryDeleteVersionRow,
  MemoryEvolutionLinkRow,
  MemoryLinkRow,
  MemoryPatchEventRow,
  MemoryRow,
  ScratchpadRow,
} from './types.js';

export function mapMemoryDeleteVersionRow(row: MemoryDeleteVersionRow): MemoryDeleteVersion {
  let snapshot: PurrMemory;
  try {
    snapshot = JSON.parse(row.snapshot_json) as PurrMemory;
  } catch {
    snapshot = {
      id: row.memory_id,
      text: '',
      type: 'semantic',
      importance: 0.5,
      confidence: 0.7,
      emotionalValence: 0,
      salience: 0.5,
      sourceRef: 'snapshot:corrupt',
      extractedAt: row.deleted_at,
      lastAccessed: row.deleted_at,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
    };
  }

  return {
    deleteId: row.delete_id,
    memoryId: row.memory_id,
    snapshot,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by ?? 'unknown',
    deleteReason: row.delete_reason ?? undefined,
    restoredAt: row.restored_at ?? undefined,
    restoredBy: row.restored_by ?? undefined,
  };
}

export function mapMemoryLinkRow(row: MemoryLinkRow): MemoryLink {
  return {
    id1: row.id1,
    id2: row.id2,
    linkType: row.link_type,
    createdAt: row.created_at,
  };
}

export function mapMemoryAbstractionLinkRow(row: MemoryAbstractionLinkRow): MemoryAbstractionLink {
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    abstractedMemoryId: row.abstracted_memory_id,
    externalRef: row.external_ref,
    createdAt: row.created_at,
    createdBy: row.created_by ?? undefined,
    reason: row.reason ?? undefined,
  };
}

function parseJsonStringArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export function parseJsonRecord(
  value: string | null,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : fallback;
  } catch {
    return fallback;
  }
}

export function mapMemoryEvolutionLinkRow(row: MemoryEvolutionLinkRow): MemoryEvolutionLink {
  const relation = (MEMORY_EVOLUTION_RELATIONS as readonly string[]).includes(row.relation)
    ? row.relation as MemoryEvolutionLink['relation']
    : 'updates';
  const provenance = normalizeMemoryProvenance(parseJsonRecord(row.provenance_json, {}));
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    relation,
    confidence: row.confidence,
    reason: row.reason ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    sourceType: normalizeMemorySourceType(row.source_type),
    provenanceRefs: parseJsonStringArray(row.provenance_refs),
    ...(provenance ? { provenance } : {}),
    createdAt: row.created_at,
  };
}

export function mapMemoryPatchEventRow(row: MemoryPatchEventRow): MemoryPatchEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    sourceRef: row.source_ref,
    sourceType: normalizeMemorySourceType(row.source_type),
    provenance: normalizeMemoryProvenance(parseJsonRecord(row.provenance_json, {})),
    reason: row.reason ?? undefined,
    patch: parseJsonRecord(row.patch_json),
    previousValues: parseJsonRecord(row.previous_json),
    nextValues: parseJsonRecord(row.next_json),
    createdAt: row.created_at,
  };
}

export function mapMemoryRow(row: MemoryRow): PurrMemory {
  let tags: string[] = [];
  let scopeTags: string[] = [];
  let provenanceRefs: string[] = [];
  let consentFlags: ConsentFlags = {};
  let formationVAD: MemoryFormationVAD | undefined;
  let provenance: MemoryProvenance | undefined;
  let scopeRef: MemoryScopeRef | undefined;
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  try {
    const parsed = JSON.parse(row.scope_tags ?? '[]');
    scopeTags = Array.isArray(parsed)
      ? normalizeMemoryScopeTags(parsed.filter((entry): entry is string => typeof entry === 'string'))
      : [];
  } catch {
    scopeTags = [];
  }
  try {
    const parsed = JSON.parse(row.provenance_refs ?? '[]');
    provenanceRefs = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
  } catch {
    provenanceRefs = [];
  }
  try {
    consentFlags = normalizeConsentFlags(JSON.parse(row.consent_flags ?? '{}'));
  } catch {
    consentFlags = {};
  }
  try {
    const parsed = JSON.parse(row.formation_vad ?? 'null');
    formationVAD = normalizeFormationVAD(parsed as Partial<MemoryFormationVAD> | undefined);
  } catch {
    formationVAD = undefined;
  }
  try {
    provenance = normalizeMemoryProvenance(JSON.parse(row.provenance_json ?? '{}'));
  } catch {
    provenance = undefined;
  }
  scopeRef = normalizeMemoryScopeRef({
    kind: row.scope_ref_kind ?? '',
    id: row.scope_ref_id ?? '',
    ...(row.scope_ref_label ? { label: row.scope_ref_label } : {}),
  });

  return {
    id: row.id,
    text: row.text,
    type: row.type,
    importance: row.importance,
    confidence: row.confidence,
    emotionalValence: row.emotional_valence,
    formationVAD,
    salience: row.salience,
    sourceRef: row.source_ref,
    sourceType: normalizeMemorySourceType(row.source_type, inferMemorySourceTypeFromSourceRef(row.source_ref)),
    ...(provenance ? { provenance } : {}),
    extractedAt: row.extracted_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    supersededBy: row.superseded_by ?? undefined,
    tags,
    ...(scopeRef ? { scopeRef } : {}),
    ...(scopeTags.length > 0 ? { scopeTags } : {}),
    provenanceRefs,
    sensitivity: (row.sensitivity ?? 'personal') as SensitivityLevel,
    consentFlags,
    contactId: row.contact_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
    deleteReason: row.delete_reason ?? undefined,
  };
}

export function mapScratchpadRow(row: ScratchpadRow): ScratchpadEntry {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
