/** Companion/community-scoped Buzz delivery recovery and subscription state. */
export const POSTGRES_BUZZ_RECOVERY_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS buzz_inbound_recovery (
    community TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    event_created_at BIGINT NOT NULL,
    state TEXT NOT NULL,
    outbound_event_json JSONB,
    suppression_reason TEXT,
    claimed_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (community, companion_id, event_id),
    CHECK (event_id ~ '^[a-f0-9]{64}$'),
    CHECK (event_created_at >= 0),
    CHECK (state IN ('processing', 'ready', 'completed', 'suppressed')),
    CHECK ((state IN ('ready', 'completed')) = (outbound_event_json IS NOT NULL)),
    CHECK ((state = 'suppressed') = (suppression_reason IS NOT NULL)),
    CHECK (suppression_reason IS NULL OR suppression_reason IN (
      'autonomous_hop_limit', 'duplicate_causal_edge', 'invalid_causal_parent',
      'no_information_acknowledgement', 'fatigue_suppressed',
      'broadcast_approval_required', 'intentional_no_reply', 'empty_response',
      'turn_cancelled'
    )),
    CHECK (outbound_event_json IS NULL OR jsonb_typeof(outbound_event_json) = 'object'),
    CHECK (outbound_event_json IS NULL OR octet_length(outbound_event_json::text) <= 131072)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_buzz_inbound_recovery_pending
    ON buzz_inbound_recovery(community, companion_id, state, event_created_at, event_id);`,
  `
  CREATE TABLE IF NOT EXISTS buzz_causal_events (
    community TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    root_event_id TEXT NOT NULL,
    parent_event_id TEXT,
    hop INTEGER NOT NULL,
    author_pubkey TEXT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (community, companion_id, event_id),
    UNIQUE (community, companion_id, root_event_id, parent_event_id, author_pubkey),
    CHECK (event_id ~ '^[a-f0-9]{64}$'),
    CHECK (root_event_id ~ '^[a-f0-9]{64}$'),
    CHECK (parent_event_id IS NULL OR parent_event_id ~ '^[a-f0-9]{64}$'),
    CHECK (author_pubkey ~ '^[a-f0-9]{64}$'),
    CHECK (hop >= 0),
    CHECK ((hop = 0) = (parent_event_id IS NULL))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_buzz_causal_events_parent
    ON buzz_causal_events(community, companion_id, event_id, root_event_id, channel_id, hop);`,
  `
  CREATE TABLE IF NOT EXISTS buzz_replay_checkpoints (
    community TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    event_created_at BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (community, companion_id),
    CHECK (event_created_at >= 0)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS buzz_room_memberships (
    community TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    active BOOLEAN NOT NULL,
    event_created_at BIGINT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (community, companion_id, channel_id),
    CHECK (event_created_at >= 0),
    CHECK (event_id ~ '^[a-f0-9]{64}$')
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_buzz_room_memberships_active
    ON buzz_room_memberships(community, companion_id, active, channel_id);`,
];
