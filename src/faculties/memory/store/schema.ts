import type Database from 'better-sqlite3';
import { hasColumn } from '../../../persistence/sqlite-utils.js';

export function createMemoryStoreSchema(db: Database.Database, embeddingDims: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS l2_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.7,
      emotional_valence REAL NOT NULL DEFAULT 0.0,
      formation_vad TEXT,
      salience REAL NOT NULL DEFAULT 0.5,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'unknown',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      extracted_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      scope_ref_kind TEXT,
      scope_ref_id TEXT,
      scope_ref_label TEXT,
      scope_tags TEXT NOT NULL DEFAULT '[]',
      provenance_refs TEXT NOT NULL DEFAULT '[]',
      retention_class TEXT CHECK (retention_class IN ('standard', 'durable') OR retention_class IS NULL),
      contact_id TEXT,
      deleted_at INTEGER,
      deleted_by TEXT,
      delete_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l2_type ON l2_memories(type);
    CREATE INDEX IF NOT EXISTS idx_l2_salience ON l2_memories(salience);

    CREATE TABLE IF NOT EXISTS contact_profiles (
      contact_id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      confidence_score REAL NOT NULL DEFAULT 0,
      novelty_score REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_profiles_updated_at ON contact_profiles(updated_at);

    CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
      delete_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      deleted_by TEXT,
      delete_reason TEXT,
      restored_at INTEGER,
      restored_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id);
    CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at);

    CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      abstracted_memory_id TEXT NOT NULL,
      external_ref TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id);
    CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id);

    CREATE TABLE IF NOT EXISTS memory_evolution_links (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('supersedes', 'updates', 'negates', 'conflicts_with')),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      reason TEXT,
      source_ref TEXT,
      source_type TEXT NOT NULL DEFAULT 'unknown',
      provenance_refs TEXT NOT NULL DEFAULT '[]',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      CHECK (source_memory_id <> target_memory_id),
      UNIQUE (source_memory_id, target_memory_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source ON memory_evolution_links(source_memory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_target ON memory_evolution_links(target_memory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_relation ON memory_evolution_links(relation, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source_ref ON memory_evolution_links(source_ref, source_type);

    CREATE TABLE IF NOT EXISTS l2_memory_patch_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT,
      patch_json TEXT NOT NULL,
      previous_json TEXT NOT NULL,
      next_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l2_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS l2_memory_maintenance_reviews (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_memory_id TEXT NOT NULL,
      candidate_memory_ids TEXT NOT NULL DEFAULT '[]',
      state_json TEXT NOT NULL,
      quarantine_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_status ON l2_memory_maintenance_reviews(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_kind ON l2_memory_maintenance_reviews(kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_subject ON l2_memory_maintenance_reviews(subject_memory_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_links (
      id1 TEXT NOT NULL,
      id2 TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id1, id2)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1);
    CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2);

    CREATE VIRTUAL TABLE IF NOT EXISTS l2_memory_embeddings USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${embeddingDims}]
    );

    CREATE TABLE IF NOT EXISTS scratchpad_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC);
  `);
}

export function migrateMemoryStoreSchema(db: Database.Database): void {
  // Preserve the historical ALTER TABLE idempotency behavior for sensitivity/consent.
  try {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal'`);
  } catch { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN consent_flags TEXT NOT NULL DEFAULT '{}'`);
  } catch { /* column already exists */ }

  if (!hasColumn(db, 'l2_memories', 'contact_id')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN contact_id TEXT`);
  }

  if (hasColumn(db, 'l2_memories', 'contact_id')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_contact ON l2_memories(contact_id)`);
  }

  if (!hasColumn(db, 'l2_memories', 'provenance_refs')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_refs TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!hasColumn(db, 'l2_memories', 'retention_class')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN retention_class TEXT`);
  }
  if (!hasColumn(db, 'l2_memories', 'scope_ref_kind')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_kind TEXT`);
  }
  if (!hasColumn(db, 'l2_memories', 'scope_ref_id')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_id TEXT`);
  }
  if (!hasColumn(db, 'l2_memories', 'scope_ref_label')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_ref_label TEXT`);
  }
  if (!hasColumn(db, 'l2_memories', 'scope_tags')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN scope_tags TEXT NOT NULL DEFAULT '[]'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id)`);

  if (!hasColumn(db, 'l2_memories', 'formation_vad')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN formation_vad TEXT`);
  }
  if (!hasColumn(db, 'l2_memories', 'source_type')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown'`);
  }
  if (!hasColumn(db, 'l2_memories', 'provenance_json')) {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}'`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_source_type ON l2_memories(source_type)`);

  try {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_at INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN deleted_by TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE l2_memories ADD COLUMN delete_reason TEXT`);
  } catch { /* column already exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_deleted_at ON l2_memories(deleted_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_admin_active ON l2_memories(superseded_by, deleted_at, extracted_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_admin_type ON l2_memories(type, superseded_by, deleted_at, extracted_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_admin_sensitivity ON l2_memories(sensitivity, superseded_by, deleted_at, extracted_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_admin_retention ON l2_memories(retention_class, superseded_by, deleted_at, extracted_at DESC, id DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
      delete_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      deleted_by TEXT,
      delete_reason TEXT,
      restored_at INTEGER,
      restored_by TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS l2_memory_patch_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT,
      patch_json TEXT NOT NULL,
      previous_json TEXT NOT NULL,
      next_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_patch_events_memory ON l2_memory_patch_events(memory_id, created_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS l2_memory_maintenance_reviews (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_memory_id TEXT NOT NULL,
      candidate_memory_ids TEXT NOT NULL DEFAULT '[]',
      state_json TEXT NOT NULL,
      quarantine_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_status ON l2_memory_maintenance_reviews(status, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_kind ON l2_memory_maintenance_reviews(kind, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_maintenance_reviews_subject ON l2_memory_maintenance_reviews(subject_memory_id, updated_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      abstracted_memory_id TEXT NOT NULL,
      external_ref TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      reason TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_evolution_links (
      id TEXT PRIMARY KEY,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('supersedes', 'updates', 'negates', 'conflicts_with')),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      reason TEXT,
      source_ref TEXT,
      source_type TEXT NOT NULL DEFAULT 'unknown',
      provenance_refs TEXT NOT NULL DEFAULT '[]',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      CHECK (source_memory_id <> target_memory_id),
      UNIQUE (source_memory_id, target_memory_id, relation)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source ON memory_evolution_links(source_memory_id, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_target ON memory_evolution_links(target_memory_id, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_relation ON memory_evolution_links(relation, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_evolution_links_source_ref ON memory_evolution_links(source_ref, source_type)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scratchpad_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      id1 TEXT NOT NULL,
      id2 TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id1, id2)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2)`);
}
