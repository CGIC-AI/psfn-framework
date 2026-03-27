CREATE TABLE IF NOT EXISTS active_concerns (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_outcome TEXT,
  contact_id TEXT,
  formation_vad TEXT,
  CHECK (priority IN ('high', 'medium', 'low')),
  CHECK (source IN ('appraisal', 'agent', 'heartbeat'))
);

CREATE INDEX IF NOT EXISTS idx_active_concerns_active
  ON active_concerns (resolved_at, expires_at, priority, created_at, id);
CREATE INDEX IF NOT EXISTS idx_active_concerns_contact
  ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);

CREATE TABLE IF NOT EXISTS behavioral_pattern_events (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  response_excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  outcome_score REAL,
  outcome_observed_at TEXT,
  outcome_source_message_id TEXT,
  promoted_at TEXT,
  promoted_memory_id TEXT,
  CHECK (
    outcome_score IS NULL
    OR (outcome_score >= -1 AND outcome_score <= 1)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_behavioral_pattern_unique_turn
  ON behavioral_pattern_events (contact_id, source_message_id, strategy);
CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_contact_created
  ON behavioral_pattern_events (contact_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_pending
  ON behavioral_pattern_events (contact_id, strategy, outcome_score, created_at DESC);

CREATE TABLE IF NOT EXISTS intention_pending_follow_ups (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  priority TEXT NOT NULL,
  timing TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  due_at TEXT,
  contact_id TEXT,
  source_message_id TEXT,
  activated_at TEXT,
  activation_reason TEXT,
  CHECK (priority IN ('low', 'medium', 'high')),
  CHECK (timing IN ('immediate', 'soon', 'scheduled')),
  CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
);

CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active
  ON intention_pending_follow_ups (activated_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact
  ON intention_pending_follow_ups (contact_id, activated_at, created_at, id);
