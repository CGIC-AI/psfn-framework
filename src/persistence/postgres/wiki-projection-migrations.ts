import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';

// E8.3: pgvector projection of canonical workspace wiki documents. This is a
// rebuildable mirror (charter 6.23/7.5): the workspace Markdown + metadata are
// the source of truth, and every row is keyed by document id + body_sha256 so
// checksum drift is detectable and the projection can be rebuilt/repaired from
// the canonical files at any time. Projection loss never corrupts the archive;
// it only degrades semantic search until rebuilt.
export const POSTGRES_WIKI_PROJECTION_MIGRATIONS = [
  POSTGRES_VECTOR_EXTENSION_MIGRATION,
  `
  CREATE TABLE IF NOT EXISTS wiki_document_chunks (
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    body_sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    body_path TEXT NOT NULL,
    source_class TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    chunk_text TEXT NOT NULL,
    chunk_char_count INTEGER NOT NULL,
    embedding VECTOR NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (document_id, chunk_index)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_doc ON wiki_document_chunks(document_id);`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_sha ON wiki_document_chunks(document_id, body_sha256);`,
  // W5b scope dimension: chunks carry their document's scope so retrieval can
  // filter at query time (personal always, plus the current site's shared world
  // scope). Additive with a `personal` default: pre-W5b rows and the flag-off
  // (unfiltered) query path are byte-identical.
  `ALTER TABLE wiki_document_chunks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_document_chunks_scope ON wiki_document_chunks(scope);`,
];
