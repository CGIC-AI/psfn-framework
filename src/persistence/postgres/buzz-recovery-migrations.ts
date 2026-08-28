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
      'observation_only', 'turn_cancelled'
    )),
    CHECK (outbound_event_json IS NULL OR jsonb_typeof(outbound_event_json) = 'object'),
    CHECK (outbound_event_json IS NULL OR octet_length(outbound_event_json::text) <= 131072)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_buzz_inbound_recovery_pending
    ON buzz_inbound_recovery(community, companion_id, state, event_created_at, event_id);`,
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
  `
  DO $buzz_observation_suppression$
  DECLARE stale_constraint TEXT;
  BEGIN
    FOR stale_constraint IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'buzz_inbound_recovery'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%suppression_reason%'
        AND pg_get_constraintdef(oid) LIKE '%autonomous_hop_limit%'
        AND pg_get_constraintdef(oid) NOT LIKE '%observation_only%'
    LOOP
      EXECUTE format(
        'ALTER TABLE buzz_inbound_recovery DROP CONSTRAINT %I',
        stale_constraint
      );
    END LOOP;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'buzz_inbound_recovery'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%suppression_reason%'
        AND pg_get_constraintdef(oid) LIKE '%observation_only%'
    ) THEN
      ALTER TABLE buzz_inbound_recovery
        ADD CONSTRAINT buzz_inbound_recovery_suppression_reason_values_check
        CHECK (suppression_reason IS NULL OR suppression_reason IN (
          'autonomous_hop_limit', 'duplicate_causal_edge', 'invalid_causal_parent',
          'no_information_acknowledgement', 'fatigue_suppressed',
          'broadcast_approval_required', 'intentional_no_reply', 'empty_response',
          'observation_only', 'turn_cancelled'
        ));
    END IF;
  END
  $buzz_observation_suppression$;
  `,
];
