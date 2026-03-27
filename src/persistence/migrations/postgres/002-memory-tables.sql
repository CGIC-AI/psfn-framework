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
  extracted_at BIGINT NOT NULL,
  last_accessed BIGINT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  scope_ref_kind TEXT,
  scope_ref_id TEXT,
  scope_ref_label TEXT,
  scope_tags TEXT NOT NULL DEFAULT '[]',
  provenance_refs TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL DEFAULT 'personal',
  consent_flags TEXT NOT NULL DEFAULT '{}',
  contact_id TEXT,
  deleted_at BIGINT,
  deleted_by TEXT,
  delete_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_l2_type ON l2_memories(type);
CREATE INDEX IF NOT EXISTS idx_l2_salience ON l2_memories(salience);
CREATE INDEX IF NOT EXISTS idx_l2_contact ON l2_memories(contact_id);
CREATE INDEX IF NOT EXISTS idx_l2_deleted_at ON l2_memories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_l2_scope_ref ON l2_memories(scope_ref_kind, scope_ref_id);

CREATE TABLE IF NOT EXISTS l2_memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  embedding vector
);

CREATE INDEX IF NOT EXISTS idx_l2_memory_embeddings_hnsw
  ON l2_memory_embeddings USING hnsw (embedding vector_l2_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS contact_profiles (
  contact_id TEXT PRIMARY KEY,
  summary_text TEXT NOT NULL,
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  confidence_score REAL NOT NULL DEFAULT 0,
  novelty_score REAL NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_profiles_updated_at ON contact_profiles(updated_at);

CREATE TABLE IF NOT EXISTS l2_memory_delete_versions (
  delete_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  deleted_at BIGINT NOT NULL,
  deleted_by TEXT,
  delete_reason TEXT,
  restored_at BIGINT,
  restored_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_memory ON l2_memory_delete_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_l2_delete_versions_active ON l2_memory_delete_versions(restored_at, deleted_at);

CREATE TABLE IF NOT EXISTS l2_memory_abstraction_links (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  abstracted_memory_id TEXT NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  created_by TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_l2_abstraction_source ON l2_memory_abstraction_links(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_l2_abstraction_abstracted ON l2_memory_abstraction_links(abstracted_memory_id);

CREATE TABLE IF NOT EXISTS memory_links (
  id1 TEXT NOT NULL,
  id2 TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'related',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (id1, id2)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_id1 ON memory_links(id1);
CREATE INDEX IF NOT EXISTS idx_memory_links_id2 ON memory_links(id2);

CREATE TABLE IF NOT EXISTS scratchpad_entries (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scratchpad_updated_at ON scratchpad_entries(updated_at DESC, created_at DESC);
