import type { MemoryJournal } from '../journal.js';
import type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryLink,
  MemoryPatchEvent,
  ScratchpadEntry,
  MemoryMaintenanceReview,
} from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';

export interface MemoryRow {
  id: string;
  text: string;
  type: PurrMemory['type'];
  importance: number;
  confidence: number;
  emotional_valence: number;
  formation_vad: string | null;
  salience: number;
  source_ref: string;
  source_type: string | null;
  provenance_json: string | null;
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  superseded_by: string | null;
  tags: string;
  scope_ref_kind: string | null;
  scope_ref_id: string | null;
  scope_ref_label: string | null;
  scope_tags: string | null;
  provenance_refs: string | null;
  sensitivity: string | null;
  consent_flags: string | null;
  contact_id: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  delete_reason: string | null;
}

export interface MemoryDeleteVersionRow {
  delete_id: string;
  memory_id: string;
  snapshot_json: string;
  deleted_at: number;
  deleted_by: string | null;
  delete_reason: string | null;
  restored_at: number | null;
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
  provenance_refs: string | null;
  provenance_json: string | null;
  created_at: number;
}

export interface MemoryPatchEventRow {
  id: string;
  memory_id: string;
  source_ref: string;
  source_type: string;
  provenance_json: string | null;
  reason: string | null;
  patch_json: string;
  previous_json: string;
  next_json: string;
  created_at: number;
}

export interface MemoryMaintenanceReviewRow {
  id: string;
  kind: string;
  status: string;
  subject_memory_id: string;
  candidate_memory_ids: string | null;
  state_json: string | null;
  quarantine_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryLinkRow {
  id1: string;
  id2: string;
  link_type: string;
  created_at: number;
}

export interface ContactProfileRow {
  contact_id: string;
  summary_text: string;
  source_memory_ids: string;
  confidence_score: number;
  novelty_score: number;
  updated_at: number;
}

export interface ScratchpadRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface MemoryStoreOptions {
  notesDir?: string;
  scratchpadMirrorPath?: string;
  journal?: MemoryJournal;
}

export type MemorySearchResult = PurrMemory & { similarity: number };

export type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryLink,
  MemoryPatchEvent,
  MemoryMaintenanceReview,
  ScratchpadEntry,
};
