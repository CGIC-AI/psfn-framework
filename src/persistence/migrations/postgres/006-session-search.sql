CREATE TABLE IF NOT EXISTS session_messages_index (
  rowid BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  channel_visibility TEXT NOT NULL,
  UNIQUE(channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_session_messages_index_channel_timestamp
  ON session_messages_index(channel_id, timestamp DESC);

ALTER TABLE session_messages_index ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_session_fts ON session_messages_index USING gin(content_tsv);

CREATE INDEX IF NOT EXISTS idx_session_trgm ON session_messages_index USING gin(content gin_trgm_ops);
