import { randomUUID } from 'node:crypto';
import { MEMORY_EVOLUTION_RELATIONS } from '../memory-store-port.js';
import type {
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
} from '../memory-store-port.js';
import {
  inferMemorySourceTypeFromSourceRef,
  normalizeMemoryProvenance,
  normalizeMemorySourceType,
} from '../types.js';
import type { MemoryEvolutionLinkRow } from './rows.js';
import { decodeJsonRecord, decodeStringArray } from './rows.js';

export function normalizeEvolutionRelation(relation: MemoryEvolutionRelation): MemoryEvolutionRelation {
  if ((MEMORY_EVOLUTION_RELATIONS as readonly string[]).includes(relation)) {
    return relation;
  }
  throw new Error(`Invalid memory evolution relation: ${String(relation)}`);
}

export function normalizeEvolutionConfidence(confidence: number | undefined): number {
  const normalized = confidence ?? 1;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error('Memory evolution link confidence must be between 0 and 1');
  }
  return normalized;
}

export function normalizeEvolutionLinkInput(input: MemoryEvolutionLinkInput): MemoryEvolutionLink {
  const sourceMemoryId = input.sourceMemoryId.trim();
  const targetMemoryId = input.targetMemoryId.trim();
  if (!sourceMemoryId || !targetMemoryId) {
    throw new Error('sourceMemoryId and targetMemoryId are required');
  }
  if (sourceMemoryId === targetMemoryId) {
    throw new Error('Memory evolution links require distinct source and target memories');
  }
  const sourceRef = input.sourceRef?.trim() || undefined;
  const provenanceRefs = [...new Set((input.provenanceRefs ?? [])
    .map(ref => ref.trim())
    .filter(ref => ref.length > 0))];
  const provenance = normalizeMemoryProvenance(input.provenance);
  return {
    id: input.linkId?.trim() || randomUUID(),
    sourceMemoryId,
    targetMemoryId,
    relation: normalizeEvolutionRelation(input.relation),
    confidence: normalizeEvolutionConfidence(input.confidence),
    reason: input.reason?.trim() || undefined,
    sourceRef,
    sourceType: normalizeMemorySourceType(input.sourceType, sourceRef
      ? inferMemorySourceTypeFromSourceRef(sourceRef)
      : 'unknown'),
    provenanceRefs,
    ...(provenance ? { provenance } : {}),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function fromEvolutionLinkRow(row: MemoryEvolutionLinkRow): MemoryEvolutionLink {
  const relation = (MEMORY_EVOLUTION_RELATIONS as readonly string[]).includes(row.relation)
    ? row.relation as MemoryEvolutionRelation
    : 'updates';
  const provenance = normalizeMemoryProvenance(decodeJsonRecord(row.provenance_json));
  return {
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    relation,
    confidence: row.confidence,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    sourceType: normalizeMemorySourceType(row.source_type),
    provenanceRefs: decodeStringArray(row.provenance_refs),
    ...(provenance ? { provenance } : {}),
    createdAt: row.created_at,
  };
}
