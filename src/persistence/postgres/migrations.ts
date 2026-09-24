import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';
import {
  AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
} from '../../faculties/automata/bus/postgres-schema.js';
import {
  AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS,
} from '../../faculties/automata/retention-postgres-schema.js';
import {
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS,
} from './automata-exact-session-purge-store.js';

export { POSTGRES_MEMORY_MIGRATIONS } from './memory-migrations.js';
export { POSTGRES_WIKI_PROJECTION_MIGRATIONS } from './wiki-projection-migrations.js';
export { POSTGRES_CONTACT_MIGRATIONS, POSTGRES_ENROLLMENT_MIGRATIONS } from './contact-migrations.js';
export { POSTGRES_INTENTION_MIGRATIONS } from './intention-migrations.js';
export {
  POSTGRES_AUDIT_MIGRATIONS,
  POSTGRES_TRANSCRIPT_MIGRATIONS,
  POSTGRES_INTERNAL_STATE_MIGRATIONS,
  POSTGRES_PARTICIPANT_TREND_MIGRATIONS,
  POSTGRES_REFLECTION_MIGRATIONS,
} from './session-migrations.js';
export {
  POSTGRES_SCHEDULED_PROMPT_MIGRATIONS,
  POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS,
  POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS,
} from './scheduler-migrations.js';
export {
  POSTGRES_BACKGROUND_WORK_MIGRATIONS,
  POSTGRES_BACKGROUND_WORK_MIGRATION_ADVISORY_LOCK,
} from './background-work-migrations.js';
export {
  POSTGRES_MODEL_USAGE_MIGRATION_ADVISORY_LOCK,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
} from './model-usage-migrations.js';
export { POSTGRES_INTROSPECTION_MIGRATIONS, POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS } from './eval-migrations.js';

// Multi-companion world schema (sprint 10, W2). Every companion gets its own
// per-companion schema running the migration chains above; the single `shared`
// schema holds cross-companion world data (locations/presence, shared wiki
// chunks, world state). This is the SEPARATE migration chain for that schema.
//
// The chain owns its own version ledger so shared migrations are registered
// and tracked independently of the per-companion chains. World tables belong
// here, never in the per-companion chains. Current versions:
//   1 — baseline (ledger only)
//   2 — companion_presence (W5a cross-companion presence)
//   3 — shared_wiki_chunks (s10f9 shared-world wiki projection; SEPARATE
//       statement list, see POSTGRES_SHARED_WIKI_MIGRATIONS below)
//   4 — ICP autonomy content-free availability/episode/permit control plane
//   5 — icp_autonomy_invalidation_fences
//   6 — icp_fatigue_turn_reservations
//   7 — icp-fatigue delivery fence
//   8 — shared_wiki_caretaker proposals (wiki chain; version 8 reserved there)
//   9 — companion_social_pot (jp36.4.1.1)
//  10 — speaking arbiter: reservations, egress leases, per-channel room episodes
//       (jp36.5.1.1 gateway speaking arbiter, two-phase reservation/egress lease)
//  11 — speaking arbiter charge association
//  12 — icp felt_impulse initiation source (hrmrq.34, operator ruling D4)
//  13 — authenticated operator/harness ICP test initiation source (ph0mw)
//  14 — durable canonical ICP dyads with bounded activity episodes (84g0z.1)
//  15 — content-free open-dyad continuation delivery ledger (84g0z.2)
//  16 — companion-owned dyad lifecycle boundaries and revision fencing (84g0z.3)
//  17 — fleet-wide heavy-maintenance baton, demand roster, and checkpoints
//  18 — opaque process-instance fencing for fleet-maintenance holders
//  19 — bounded durable room-participation lease (jp36.5.5)
//  20 — non-expiring ICP lifecycle admission fence (h248l.9)
//  21 — fleet-wide system-owned health events and human escalations (e5r0s)
export const SHARED_SCHEMA_NAME = 'shared';

/** Ledger versions installed by POSTGRES_SHARED_MIGRATIONS (excluding wiki versions 3 and 8). */
export const POSTGRES_SHARED_BASE_MIGRATION_VERSIONS = [
  1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
] as const;
/** Complete ledger across the base and shared-wiki chains. */
export const POSTGRES_SHARED_ALL_MIGRATION_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
] as const;

/**
 * Bounded runtime health-event stream (bead psfn-framework-7qeo1.24.1).
 *
 * One append-only ring of content-free `HealthEvent` envelopes, capped by the
 * settings.json-owned `healthEventStreamMaxRows` so it survives a restart
 * without growing without bound. The columns a detector filters and joins on
 * (correlation, causation, code, severity, component, subject digest, time)
 * are first-class; the bounded structured evidence rides as a small JSONB map.
 *
 * The CHECK constraints are deliberately STRUCTURAL only. The closed
 * vocabularies for `code`, `severity`, `process`, and `component` live in
 * `shared/contracts/health-event.ts` and are enforced by `validateHealthEvent`
 * on both the write and the read path: pinning them into DDL would silently
 * drift the day a detector child adds a code, because `CREATE TABLE IF NOT
 * EXISTS` never updates an existing constraint.
 */
const RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS runtime_health_events (
    event_id UUID PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    correlation_id UUID NOT NULL,
    causation_id UUID,
    owner_kind TEXT NOT NULL,
    owner_companion_id TEXT,
    severity TEXT NOT NULL,
    code TEXT NOT NULL,
    process TEXT NOT NULL,
    component TEXT NOT NULL,
    observer_id UUID NOT NULL,
    subject_hash TEXT,
    occurrence_count INTEGER NOT NULL,
    first_observed_at_ms BIGINT NOT NULL,
    last_observed_at_ms BIGINT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    evidence_json JSONB NOT NULL,
    CHECK (owner_kind IN ('system', 'companion')),
    CHECK ((owner_kind = 'companion') = (owner_companion_id IS NOT NULL)),
    CHECK (occurrence_count >= 1),
    CHECK (first_observed_at_ms >= 0),
    CHECK (last_observed_at_ms >= first_observed_at_ms),
    CHECK (recorded_at_ms >= 0),
    CHECK (subject_hash IS NULL OR subject_hash ~ '^[0-9a-f]{64}$'),
    CHECK (jsonb_typeof(evidence_json) = 'object'),
    CHECK (octet_length(evidence_json::text) <= 4096)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_runtime_health_events_recorded
    ON runtime_health_events(recorded_at_ms DESC, event_id DESC);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_runtime_health_events_correlation
    ON runtime_health_events(correlation_id, recorded_at_ms DESC, event_id DESC);
  `,
];

/**
 * Durable human escalation ledger (bead psfn-framework-bznbn).
 *
 * Two tables because two things are being remembered, and conflating them is
 * the bug this ledger exists to prevent:
 *
 *   * `human_escalations` holds one row per CONDITION a human was asked about,
 *     keyed by `(kind, dedupe_key)`. That row is what an operator resolves, and
 *     it is what survives a restart so a runtime does not re-ask about every
 *     open condition on boot.
 *   * `human_escalation_attempts` holds one row per DELIVERY ATTEMPT, keyed by
 *     the caller's idempotency key. That primary key is the whole idempotency
 *     guarantee: a redelivered notice collides and is never dispatched twice.
 *
 * Content-free by construction, enforced structurally rather than by review.
 * There is no message, detail, note, or error column: the rendered notification
 * is handed to a sink and never persisted. The narrative half of a human
 * decision (who, in their own words) lives in the Garden audit timeline, which
 * already carries actor identity under its own retention.
 *
 * As with the health-event stream, the CHECK constraints are STRUCTURAL only.
 * The closed vocabularies for kind, severity, state, reason, actor, sink, and
 * outcome live in `shared/escalation/contracts.ts` and are enforced on both the
 * write and the read path; pinning them into DDL would silently drift the day a
 * surface adopts the plane, because `CREATE TABLE IF NOT EXISTS` never updates
 * an existing constraint.
 */
const HUMAN_ESCALATION_TABLE_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS human_escalations (
    escalation_id UUID PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_companion_id TEXT,
    dedupe_key TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    detail_path TEXT NOT NULL,
    labels_json JSONB NOT NULL,
    evidence_json JSONB NOT NULL,
    state TEXT NOT NULL,
    resolution_reason TEXT,
    resolved_by TEXT,
    resolved_at_ms BIGINT,
    raised_at_ms BIGINT NOT NULL,
    last_raised_at_ms BIGINT NOT NULL,
    last_notified_at_ms BIGINT,
    raise_count INTEGER NOT NULL,
    CHECK (owner_kind IN ('system', 'companion')),
    CHECK ((owner_kind = 'companion') = (owner_companion_id IS NOT NULL)),
    -- An escalation that left the queue always says why, and one that is still
    -- open never claims a reason it was never given.
    CHECK ((state = 'open') = (resolution_reason IS NULL)),
    CHECK ((resolution_reason IS NULL) = (resolved_at_ms IS NULL)),
    CHECK ((resolution_reason IS NULL) = (resolved_by IS NULL)),
    CHECK (raise_count >= 1),
    CHECK (raised_at_ms >= 0),
    CHECK (last_raised_at_ms >= raised_at_ms),
    CHECK (last_notified_at_ms IS NULL OR last_notified_at_ms >= 0),
    CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= 0),
    CHECK (jsonb_typeof(labels_json) = 'array'),
    CHECK (jsonb_typeof(evidence_json) = 'object'),
    CHECK (octet_length(labels_json::text) <= 1024),
    CHECK (octet_length(evidence_json::text) <= 4096),
    CHECK (detail_path ~ '^/[a-z0-9/-]*$'),
    CHECK (length(dedupe_key) BETWEEN 1 AND 256),
    CHECK (length(source_ref) BETWEEN 1 AND 256)
  );
  `,
  `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_human_escalations_condition
    ON human_escalations(kind, dedupe_key);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_human_escalations_attention
    ON human_escalations(state, last_raised_at_ms DESC, escalation_id DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS human_escalation_attempts (
    idempotency_key TEXT PRIMARY KEY,
    escalation_id UUID NOT NULL
      REFERENCES human_escalations(escalation_id) ON DELETE CASCADE,
    sink TEXT NOT NULL,
    outcome TEXT NOT NULL,
    attempted_at_ms BIGINT NOT NULL,
    CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    CHECK (attempted_at_ms >= 0)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_human_escalation_attempts_escalation
    ON human_escalation_attempts(escalation_id, attempted_at_ms DESC);
  `,
];

export const POSTGRES_SHARED_MIGRATIONS: readonly string[] = [
  // Version ledger for the shared schema. Independent of the per-companion
  // chains (which are idempotent CREATE ... IF NOT EXISTS lists); this table is
  // the registration point that lets the shared chain track applied versions as
  // world tables are added.
  `
  CREATE TABLE IF NOT EXISTS shared_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
  // Register the baseline (infrastructure-only) version. No world tables yet.
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (1, 'shared-schema-baseline')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 2 (sprint 10, W5a): cross-companion presence. The durable authority
  // for "which companion is at which place". One row per companion, written by
  // that companion's own agent process only. NOTHING personal ever lands in
  // this table — presence is companion id + place coordinates + timestamps.
  //
  // `since` is when the companion arrived at its CURRENT place (preserved on
  // same-place refreshes, reset on moves); `updated_at` is the freshness beat —
  // readers treat rows older than a TTL as stale so a crashed agent never
  // leaves a permanent ghost (graceful shutdown deletes the row outright).
  `
  CREATE TABLE IF NOT EXISTS companion_presence (
    companion_id UUID PRIMARY KEY,
    site_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
    since TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  `,
  // Co-presence reads are always "who else is at THIS place".
  `
  CREATE INDEX IF NOT EXISTS idx_companion_presence_place
    ON companion_presence (site_id, place_id);
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (2, 'companion-presence')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 4 (s10mc.6.1): content-free ICP autonomy control plane. Candidate
  // motivation remains private in each companion schema; shared state carries
  // only coarse availability, episode correlation, and replay-safe permits.
  `
  CREATE TABLE IF NOT EXISTS icp_availability_leases (
    companion_id UUID PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN (
      'available', 'open_to_chat', 'busy', 'resting', 'do_not_disturb'
    )),
    issued_at_ms BIGINT NOT NULL CHECK (issued_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > issued_at_ms),
    source TEXT NOT NULL CHECK (source IN ('companion', 'operator', 'runtime')),
    revision BIGINT NOT NULL CHECK (revision >= 1)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_icp_availability_leases_expiry
    ON icp_availability_leases (expires_at_ms, companion_id);`,
  `
  CREATE TABLE IF NOT EXISTS icp_conversation_episodes (
    conversation_id UUID PRIMARY KEY,
    channel_id TEXT NOT NULL,
    participant_companion_ids UUID[] NOT NULL,
    root_initiation_id UUID NOT NULL,
    initiated_by_companion_id UUID NOT NULL,
    initiation_source TEXT NOT NULL CHECK (initiation_source IN (
      'free_time', 'weighted_thought', 'intention', 'foreground', 'felt_impulse', 'operator_test'
    )),
    provenance_ref TEXT NOT NULL,
    opened_at_ms BIGINT NOT NULL CHECK (opened_at_ms >= 0),
    last_activity_at_ms BIGINT NOT NULL CHECK (last_activity_at_ms >= opened_at_ms),
    status TEXT NOT NULL CHECK (status IN (
      'invited', 'active', 'declined', 'deferred', 'ended', 'suppressed'
    )),
    close_reason_code TEXT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    CHECK (cardinality(participant_companion_ids) >= 2),
    CHECK (array_position(participant_companion_ids, NULL) IS NULL),
    CHECK (initiated_by_companion_id = ANY(participant_companion_ids))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_icp_conversation_episodes_status
    ON icp_conversation_episodes (status, last_activity_at_ms, conversation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_icp_conversation_episodes_channel
    ON icp_conversation_episodes (channel_id, last_activity_at_ms, conversation_id);`,
  `
  CREATE TABLE IF NOT EXISTS icp_initiation_permits (
    permit_id UUID PRIMARY KEY,
    candidate_id UUID NOT NULL,
    conversation_id UUID NOT NULL REFERENCES icp_conversation_episodes(conversation_id) ON DELETE RESTRICT,
    sender_companion_id UUID NOT NULL,
    recipient_companion_id UUID NOT NULL,
    channel_id TEXT NOT NULL,
    provenance_ref TEXT NOT NULL,
    issued_at_ms BIGINT NOT NULL CHECK (issued_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > issued_at_ms),
    status TEXT NOT NULL CHECK (status IN ('issued', 'consumed', 'revoked', 'expired')),
    consumed_at_ms BIGINT,
    revoked_at_ms BIGINT,
    reason_code TEXT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    UNIQUE (candidate_id),
    CHECK (sender_companion_id <> recipient_companion_id),
    CHECK ((status = 'consumed') = (consumed_at_ms IS NOT NULL)),
    CHECK ((status = 'revoked') = (revoked_at_ms IS NOT NULL)),
    CHECK (consumed_at_ms IS NULL OR (
      consumed_at_ms >= issued_at_ms AND consumed_at_ms < expires_at_ms
    )),
    CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_icp_initiation_permits_conversation
    ON icp_initiation_permits (conversation_id, status, expires_at_ms, permit_id);`,
  `CREATE INDEX IF NOT EXISTS idx_icp_initiation_permits_expiry
    ON icp_initiation_permits (status, expires_at_ms, permit_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_initiation_permits_outstanding_pair
    ON icp_initiation_permits (
      LEAST(sender_companion_id, recipient_companion_id),
      GREATEST(sender_companion_id, recipient_companion_id)
    ) WHERE status = 'issued';`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (4, 'icp-autonomy-control-plane')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 5 (s10mc.6.2): durable invalidation generations serialize permit
  // issue/consume against DND, block, disconnect, fleet, and operator changes.
  // The row lock is the lifecycle linearization point shared by every gateway
  // process; last_reason_code lets a stale operation fail closed truthfully.
  `
  CREATE TABLE IF NOT EXISTS icp_autonomy_invalidation_fences (
    companion_id UUID PRIMARY KEY,
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    invalidated_at_ms BIGINT,
    last_reason_code TEXT,
    CHECK ((generation = 0) = (invalidated_at_ms IS NULL)),
    CHECK ((generation = 0) = (last_reason_code IS NULL)),
    CHECK (invalidated_at_ms IS NULL OR invalidated_at_ms >= 0)
  );
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (5, 'icp-autonomy-invalidation-fences')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 6 (s10mc.6.6): content-free, durable pre-model fatigue
  // reservations. The canonical pair lock serializes DM/room continuations;
  // local_companion_id keeps the two companions' fatigue choices independent.
  `
  CREATE TABLE IF NOT EXISTS icp_fatigue_turn_reservations (
    turn_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES icp_conversation_episodes(conversation_id) ON DELETE RESTRICT,
    root_initiation_id UUID NOT NULL,
    local_companion_id UUID NOT NULL,
    peer_companion_id UUID NOT NULL,
    peer_contact_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('charged', 'overcharge')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    reserved_at_ms BIGINT NOT NULL CHECK (reserved_at_ms >= 0),
    finalized_at_ms BIGINT,
    outcome TEXT NOT NULL CONSTRAINT icp_fatigue_turn_reservations_outcome_check
      CHECK (outcome IN ('pending', 'delivering', 'delivered', 'no_reply', 'failed')),
    CHECK (local_companion_id <> peer_companion_id),
    CONSTRAINT icp_fatigue_turn_reservations_lifecycle_check
      CHECK ((outcome IN ('pending', 'delivering')) = (finalized_at_ms IS NULL)),
    CHECK (finalized_at_ms IS NULL OR finalized_at_ms >= reserved_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_icp_fatigue_reservations_relationship
    ON icp_fatigue_turn_reservations (
      local_companion_id, peer_companion_id, reserved_at_ms, turn_id
    ) WHERE outcome IN ('pending', 'delivering', 'delivered', 'no_reply');`,
  `CREATE INDEX IF NOT EXISTS idx_icp_fatigue_reservations_root
    ON icp_fatigue_turn_reservations (
      local_companion_id, peer_companion_id, root_initiation_id, decision, turn_id
    ) WHERE outcome IN ('pending', 'delivering', 'delivered', 'no_reply');`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (6, 'icp-fatigue-turn-reservations')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 7 (s10mc.6.6 review remediation): a recorded response is fenced
  // as delivering before egress. This forward migration also upgrades local
  // databases that already exercised the earlier unmerged version-6 shape.
  `
  DO $$
  DECLARE
    lifecycle_constraint_name TEXT;
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM shared_schema_migrations WHERE version = 7
    ) THEN
      SELECT constraint_row.conname INTO lifecycle_constraint_name
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'icp_fatigue_turn_reservations'::regclass
        AND constraint_row.contype = 'c'
        AND POSITION('outcome' IN pg_get_constraintdef(constraint_row.oid)) > 0
        AND POSITION('pending' IN pg_get_constraintdef(constraint_row.oid)) > 0
        AND POSITION('finalized_at_ms' IN pg_get_constraintdef(constraint_row.oid)) > 0
      LIMIT 1;
      IF lifecycle_constraint_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE icp_fatigue_turn_reservations DROP CONSTRAINT %I',
          lifecycle_constraint_name
        );
      END IF;
      ALTER TABLE icp_fatigue_turn_reservations
        DROP CONSTRAINT IF EXISTS icp_fatigue_turn_reservations_outcome_check,
        DROP CONSTRAINT IF EXISTS icp_fatigue_turn_reservations_lifecycle_check;
      ALTER TABLE icp_fatigue_turn_reservations
        ADD CONSTRAINT icp_fatigue_turn_reservations_outcome_check
          CHECK (outcome IN ('pending', 'delivering', 'delivered', 'no_reply', 'failed')),
        ADD CONSTRAINT icp_fatigue_turn_reservations_lifecycle_check
          CHECK ((outcome IN ('pending', 'delivering')) = (finalized_at_ms IS NULL));
      DROP INDEX IF EXISTS idx_icp_fatigue_reservations_relationship;
      DROP INDEX IF EXISTS idx_icp_fatigue_reservations_root;
      CREATE INDEX idx_icp_fatigue_reservations_relationship
        ON icp_fatigue_turn_reservations (
          local_companion_id, peer_companion_id, reserved_at_ms, turn_id
        ) WHERE outcome IN ('pending', 'delivering', 'delivered', 'no_reply');
      CREATE INDEX idx_icp_fatigue_reservations_root
        ON icp_fatigue_turn_reservations (
          local_companion_id, peer_companion_id, root_initiation_id, decision, turn_id
        ) WHERE outcome IN ('pending', 'delivering', 'delivered', 'no_reply');
    END IF;
  END
  $$;
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (7, 'icp-fatigue-delivery-fence')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 9 (sprint 11, jp36.4.1.1): per-companion social pot. The durable,
  // gateway-owned fatigue-economy budget that funds group participation and ICP
  // continuation (design bible §12.6). Content-free: one row per companion
  // carrying only a numeric balance and the regeneration tick boundary the
  // balance reflects. `balance` is DOUBLE PRECISION because continuous
  // regeneration credits `cap/24` per hourly tick, which need not be integral.
  // Draw-cap enforcement and ICP-priority ordering are applied by consumers on
  // top of this state; the store only persists it across restarts.
  //
  // Version 8 is reserved by the shared-wiki chain
  // (`shared-wiki-caretaker-proposals`); both chains register into the one
  // `shared_schema_migrations` ledger, so this base-chain migration takes the
  // next free version (9), not 8.
  `
  CREATE TABLE IF NOT EXISTS companion_social_pot (
    companion_id UUID PRIMARY KEY,
    balance DOUBLE PRECISION NOT NULL CHECK (balance >= 0),
    last_regen_at_ms BIGINT NOT NULL CHECK (last_regen_at_ms >= 0),
    revision BIGINT NOT NULL CHECK (revision >= 1)
  );
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (9, 'companion-social-pot')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 10 (sprint 11, jp36.5.1.1): gateway speaking-arbiter state. The
  // durable, gateway-owned substrate for the two-phase reservation → egress-lease
  // protocol and per-channel room-episode pressure (design bible §8.5, §12.2;
  // adjudication §3 R2). Content-free: only companion ids, channel ids, opaque
  // trigger/source-event ids, timestamps, numeric pressure/counters, and lease
  // fencing tokens — never message text. All arbiter/lease/pressure state lives
  // here so a gateway reboot loses nothing (pressure, turns, leases survive).
  //
  // Per-channel room episodes: at most one OPEN episode per channel (partial
  // unique index) is the arbitration context. Pressure is a non-monetary pacing
  // scalar (§12.6 "the pot is money; episode pressure is pacing").
  `
  CREATE TABLE IF NOT EXISTS speaking_room_episodes (
    episode_id UUID PRIMARY KEY,
    channel_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    pressure DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (pressure >= 0),
    consecutive_autonomous_turns INTEGER NOT NULL DEFAULT 0
      CHECK (consecutive_autonomous_turns >= 0),
    last_speaker_companion_id UUID,
    opened_at_ms BIGINT NOT NULL CHECK (opened_at_ms >= 0),
    last_activity_at_ms BIGINT NOT NULL CHECK (last_activity_at_ms >= opened_at_ms),
    closed_at_ms BIGINT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL)),
    CHECK (closed_at_ms IS NULL OR closed_at_ms >= opened_at_ms)
  );
  `,
  // At most one open episode per channel: the live arbitration context.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_speaking_room_episodes_open_channel
    ON speaking_room_episodes (channel_id) WHERE status = 'open';`,
  `CREATE INDEX IF NOT EXISTS idx_speaking_room_episodes_channel
    ON speaking_room_episodes (channel_id, status, last_activity_at_ms);`,
  // Durable Law-36 room-episode circuit-breaker position (charter §8.11; bible
  // §12.2/§20.2; jp36.5.1.3). The breaker's prior state must survive a gateway
  // reboot so the single-probe half-open discipline holds across restarts: a
  // probe is granted ONLY on the fresh open→half_open transition, never on every
  // half_open evaluation. Additive (ADD COLUMN IF NOT EXISTS) so it applies to
  // both fresh and already-provisioned shared schemas on the idempotent chain.
  `ALTER TABLE speaking_room_episodes
    ADD COLUMN IF NOT EXISTS breaker_state TEXT NOT NULL DEFAULT 'closed';`,
  `ALTER TABLE speaking_room_episodes
    DROP CONSTRAINT IF EXISTS speaking_room_episodes_breaker_state_check;`,
  `ALTER TABLE speaking_room_episodes
    ADD CONSTRAINT speaking_room_episodes_breaker_state_check
    CHECK (breaker_state IN ('closed', 'open', 'half_open'));`,
  // Per-companion speak-least fairness stats within an episode (§8.5 priority #4,
  // §20.1). Least-recent participation + stable companion tie-break is derived
  // from these rows deterministically.
  `
  CREATE TABLE IF NOT EXISTS speaking_episode_participation (
    episode_id UUID NOT NULL
      REFERENCES speaking_room_episodes(episode_id) ON DELETE CASCADE,
    companion_id UUID NOT NULL,
    speak_count INTEGER NOT NULL DEFAULT 0 CHECK (speak_count >= 0),
    last_spoke_at_ms BIGINT,
    PRIMARY KEY (episode_id, companion_id),
    CHECK (last_spoke_at_ms IS NULL OR last_spoke_at_ms >= 0)
  );
  `,
  // Phase 1: candidate reservations. Multiple companions may reserve the SAME
  // triggering event (each independently deciding a reply may be appropriate);
  // exactly one can later win the egress lease. Dedup is per source event per
  // companion (bible §8.1) — the unique key below.
  `
  CREATE TABLE IF NOT EXISTS speaking_reservations (
    reservation_id UUID PRIMARY KEY,
    channel_id TEXT NOT NULL,
    trigger_event_id TEXT NOT NULL,
    companion_id UUID NOT NULL,
    episode_id UUID NOT NULL
      REFERENCES speaking_room_episodes(episode_id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'released', 'expired')),
    reason TEXT CHECK (reason IN (
      'silence', 'ignore', 'model_failure', 'delivered',
      'delivery_failure', 'expiry', 'superseded', 'urgent_override'
    )),
    reserved_at_ms BIGINT NOT NULL CHECK (reserved_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > reserved_at_ms),
    finalized_at_ms BIGINT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    UNIQUE (channel_id, trigger_event_id, companion_id),
    CONSTRAINT speaking_reservations_lifecycle_check
      CHECK ((status = 'reserved') = (finalized_at_ms IS NULL)),
    -- Named to avoid colliding with the column-level reason CHECK, which
    -- Postgres auto-names speaking_reservations_reason_check.
    CONSTRAINT speaking_reservations_reason_presence_check
      CHECK ((status = 'reserved') = (reason IS NULL)),
    CHECK (finalized_at_ms IS NULL OR finalized_at_ms >= reserved_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_speaking_reservations_active
    ON speaking_reservations (channel_id, trigger_event_id, expires_at_ms)
    WHERE status = 'reserved';`,
  `CREATE INDEX IF NOT EXISTS idx_speaking_reservations_episode
    ON speaking_reservations (episode_id, companion_id);`,
  // Phase 2: exclusive, fenced egress leases. At most one HELD lease per
  // triggering room event (partial unique index) — two companions never both
  // send for one trigger (§20.1). fencing_token is monotonically increasing per
  // (channel, event): a revived crashed holder presenting a stale token is
  // rejected at completion, so it can never double-send after reclaim.
  `
  CREATE TABLE IF NOT EXISTS speaking_egress_leases (
    lease_id UUID PRIMARY KEY,
    reservation_id UUID NOT NULL
      REFERENCES speaking_reservations(reservation_id) ON DELETE RESTRICT,
    channel_id TEXT NOT NULL,
    trigger_event_id TEXT NOT NULL,
    companion_id UUID NOT NULL,
    episode_id UUID NOT NULL
      REFERENCES speaking_room_episodes(episode_id) ON DELETE RESTRICT,
    fencing_token BIGINT NOT NULL CHECK (fencing_token >= 1),
    status TEXT NOT NULL CHECK (status IN (
      'held', 'released', 'expired', 'delivered', 'failed', 'overridden'
    )),
    reason TEXT CHECK (reason IN (
      'silence', 'ignore', 'model_failure', 'delivered',
      'delivery_failure', 'expiry', 'superseded', 'urgent_override'
    )),
    acquired_at_ms BIGINT NOT NULL CHECK (acquired_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > acquired_at_ms),
    finalized_at_ms BIGINT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    UNIQUE (channel_id, trigger_event_id, fencing_token),
    CONSTRAINT speaking_egress_leases_lifecycle_check
      CHECK ((status = 'held') = (finalized_at_ms IS NULL)),
    -- Named to avoid colliding with the column-level reason CHECK, which
    -- Postgres auto-names speaking_egress_leases_reason_check.
    CONSTRAINT speaking_egress_leases_reason_presence_check
      CHECK ((status = 'held') = (reason IS NULL)),
    CHECK (finalized_at_ms IS NULL OR finalized_at_ms >= acquired_at_ms)
  );
  `,
  // The exclusivity fence: only one lease per triggering event may be HELD.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_speaking_egress_leases_one_held
    ON speaking_egress_leases (channel_id, trigger_event_id) WHERE status = 'held';`,
  `CREATE INDEX IF NOT EXISTS idx_speaking_egress_leases_reservation
    ON speaking_egress_leases (reservation_id);`,
  `CREATE INDEX IF NOT EXISTS idx_speaking_egress_leases_held_expiry
    ON speaking_egress_leases (expires_at_ms) WHERE status = 'held';`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (10, 'speaking-arbiter')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 11 (sprint 11, jp36.5.3): crash-recovery charge fencing for
  // autonomous non-ICP initiations (design bible §8.5 "crash-recovery fencing";
  // review R2 crash bullet). Bind the fatigue funding draw to the durable,
  // correlation-keyed, fenced egress lease so the charge is part of the SAME
  // recovery model as ICP's reservation fence (`IcpConversationCorrelation`):
  // the pot is a running-balance store with no per-turn row, so a draw taken
  // before delivery was previously untracked and leaked on a crash. Recording
  // the drawn units on the lease makes that charge reconcilable after a gateway
  // reboot (the winning/crashed holder's lease carries what it drew). Additive
  // (ADD COLUMN IF NOT EXISTS + idempotent constraint, mirroring the breaker
  // state migration above) so it applies to both fresh and already-provisioned
  // shared schemas on the idempotent chain. The charge stays permanent on a
  // speech-terminal (delivered/overridden) lease and is refundable off a
  // reclaimed never-delivered lease; the refund policy/wiring that consumes this
  // column is the egress-sender hardening lane (qgqw.3), out of scope here.
  `ALTER TABLE speaking_egress_leases
    ADD COLUMN IF NOT EXISTS charged_units DOUBLE PRECISION NOT NULL DEFAULT 0;`,
  `ALTER TABLE speaking_egress_leases
    DROP CONSTRAINT IF EXISTS speaking_egress_leases_charged_units_check;`,
  `ALTER TABLE speaking_egress_leases
    ADD CONSTRAINT speaking_egress_leases_charged_units_check
    CHECK (charged_units >= 0);`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (11, 'speaking-arbiter-charge-association')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 12 (hrmrq.34, operator ruling D4): affect-driven ICP initiation.
  // The emo-sim would_message lever is a first-class initiation source, so the
  // shared conversation-episode ledger must accept 'felt_impulse'.
  `ALTER TABLE icp_conversation_episodes
    DROP CONSTRAINT IF EXISTS icp_conversation_episodes_initiation_source_check;`,
  `ALTER TABLE icp_conversation_episodes
    ADD CONSTRAINT icp_conversation_episodes_initiation_source_check
    CHECK (initiation_source IN (
      'free_time', 'weighted_thought', 'intention', 'foreground', 'felt_impulse', 'operator_test'
    ));`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (12, 'icp-felt-impulse-initiation-source')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 13 (ph0mw): authenticated operator/harness test initiations use
  // the normal broker and one-use permit while remaining durably distinguishable
  // from companion-authored production initiations.
  `ALTER TABLE icp_conversation_episodes
    DROP CONSTRAINT IF EXISTS icp_conversation_episodes_initiation_source_check;
   ALTER TABLE icp_conversation_episodes
    ADD CONSTRAINT icp_conversation_episodes_initiation_source_check
    CHECK (initiation_source IN (
      'free_time', 'weighted_thought', 'intention', 'foreground', 'felt_impulse', 'operator_test'
    ));`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (13, 'icp-operator-test-initiation-source')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 14 (84g0z.1): one durable relationship row owns the canonical DM
  // channel while conversation episodes remain bounded activity/accounting
  // segments. Validation precedes every mutation so ambiguous historical
  // ownership aborts the transaction without moving transcript content.
  `
  DO $migration$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM icp_conversation_episodes
      WHERE channel_id ~ '^companion-dm:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (
          cardinality(participant_companion_ids) <> 2
          OR participant_companion_ids[1] >= participant_companion_ids[2]
          OR channel_id <> 'companion-dm:' || participant_companion_ids[1]::text
            || ':' || participant_companion_ids[2]::text
        )
    ) THEN
      RAISE EXCEPTION 'ICP dyad backfill rejected ambiguous pair/channel ownership';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM icp_conversation_episodes
      WHERE channel_id = 'companion-dm:' || participant_companion_ids[1]::text
        || ':' || participant_companion_ids[2]::text
        AND cardinality(participant_companion_ids) = 2
        AND participant_companion_ids[1] < participant_companion_ids[2]
      GROUP BY participant_companion_ids[1], participant_companion_ids[2]
      HAVING count(DISTINCT channel_id) <> 1
    ) THEN
      RAISE EXCEPTION 'ICP dyad backfill rejected multiple channels for one companion pair';
    END IF;
  END
  $migration$;
  `,
  `
  CREATE TABLE IF NOT EXISTS icp_dyads (
    dyad_id UUID PRIMARY KEY,
    channel_id TEXT NOT NULL UNIQUE,
    first_companion_id UUID NOT NULL,
    second_companion_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'revoked')),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    closed_at_ms BIGINT,
    close_reason_code TEXT,
    provenance_conversation_ids UUID[] NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    UNIQUE (first_companion_id, second_companion_id),
    CHECK (first_companion_id < second_companion_id),
    CHECK (channel_id = 'companion-dm:' || first_companion_id::text || ':' || second_companion_id::text),
    CHECK (cardinality(provenance_conversation_ids) >= 1),
    CHECK (array_position(provenance_conversation_ids, NULL) IS NULL),
    CHECK (
      (status = 'open' AND closed_at_ms IS NULL AND close_reason_code IS NULL)
      OR (status <> 'open' AND closed_at_ms IS NOT NULL AND close_reason_code IS NOT NULL)
    ),
    CHECK (closed_at_ms IS NULL OR closed_at_ms >= created_at_ms)
  );
  `,
  `
  INSERT INTO icp_dyads (
    dyad_id, channel_id, first_companion_id, second_companion_id, status,
    created_at_ms, closed_at_ms, close_reason_code, provenance_conversation_ids, revision
  )
  SELECT
    (array_agg(conversation_id ORDER BY opened_at_ms, conversation_id))[1],
    channel_id,
    participant_companion_ids[1],
    participant_companion_ids[2],
    'open',
    min(opened_at_ms),
    NULL,
    NULL,
    array_agg(conversation_id ORDER BY conversation_id),
    1
  FROM icp_conversation_episodes
  WHERE cardinality(participant_companion_ids) = 2
    AND participant_companion_ids[1] < participant_companion_ids[2]
    AND channel_id = 'companion-dm:' || participant_companion_ids[1]::text
      || ':' || participant_companion_ids[2]::text
  GROUP BY channel_id, participant_companion_ids[1], participant_companion_ids[2]
  ON CONFLICT (first_companion_id, second_companion_id) DO NOTHING;
  `,
  `ALTER TABLE icp_conversation_episodes ADD COLUMN IF NOT EXISTS dyad_id UUID;`,
  `
  UPDATE icp_conversation_episodes AS episode
  SET dyad_id = dyad.dyad_id
  FROM icp_dyads AS dyad
  WHERE episode.dyad_id IS NULL
    AND episode.channel_id = dyad.channel_id
    AND episode.participant_companion_ids[1] = dyad.first_companion_id
    AND episode.participant_companion_ids[2] = dyad.second_companion_id;
  `,
  `ALTER TABLE icp_conversation_episodes
    DROP CONSTRAINT IF EXISTS icp_conversation_episodes_dyad_id_fkey;`,
  `ALTER TABLE icp_conversation_episodes
    ADD CONSTRAINT icp_conversation_episodes_dyad_id_fkey
    FOREIGN KEY (dyad_id) REFERENCES icp_dyads(dyad_id) ON DELETE RESTRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_icp_conversation_episodes_dyad
    ON icp_conversation_episodes (dyad_id, opened_at_ms, conversation_id);`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (14, 'icp-durable-dyads')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 15 (84g0z.2): established-dyad continuation is authorized from
  // content-free relationship state, and its asynchronous delivery lifecycle
  // survives gateway and agent restarts. Historical pairs whose newest episode
  // was suppressed are revoked before dyads become authorization-bearing.
  `
  WITH latest AS (
    SELECT DISTINCT ON (episode.dyad_id)
      episode.dyad_id, episode.status, episode.last_activity_at_ms
    FROM icp_conversation_episodes AS episode
    WHERE episode.dyad_id IS NOT NULL
    ORDER BY episode.dyad_id, episode.last_activity_at_ms DESC, episode.conversation_id DESC
  )
  UPDATE icp_dyads AS dyad
  SET status = 'revoked',
      closed_at_ms = latest.last_activity_at_ms,
      close_reason_code = 'conversation_suppressed',
      revision = dyad.revision + 1
  FROM latest
  WHERE latest.dyad_id = dyad.dyad_id
    AND dyad.status = 'open' AND latest.status = 'suppressed';
  `,
  `
  CREATE TABLE IF NOT EXISTS icp_dyad_deliveries (
    delivery_id UUID PRIMARY KEY,
    dyad_id UUID NOT NULL REFERENCES icp_dyads(dyad_id) ON DELETE RESTRICT,
    conversation_id UUID NOT NULL REFERENCES icp_conversation_episodes(conversation_id) ON DELETE RESTRICT,
    sender_companion_id UUID NOT NULL,
    recipient_companion_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'queued', 'delayed', 'delivered', 'ignored', 'declined', 'failed',
      'retrying', 'duplicate', 'suppressed'
    )),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    gateway_message_id TEXT,
    reason_code TEXT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    CHECK (sender_companion_id <> recipient_companion_id),
    CHECK ((outcome IN ('delivered', 'duplicate')) = (gateway_message_id IS NOT NULL))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_icp_dyad_deliveries_latest
    ON icp_dyad_deliveries (dyad_id, updated_at_ms DESC, delivery_id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_icp_dyad_deliveries_sender
    ON icp_dyad_deliveries (sender_companion_id, updated_at_ms DESC);`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (15, 'icp-open-dyad-continuation')
  ON CONFLICT (version) DO NOTHING;
  `,
  // Version 16 (84g0z.3): each participant owns a reason-free relationship
  // grant and an independent block flag. The lifecycle revision changes only
  // for relationship boundaries, so queued work can be fenced without episode
  // activity/provenance updates revoking otherwise valid authority.
  `ALTER TABLE icp_dyads
    ADD COLUMN IF NOT EXISTS first_relationship_state TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS second_relationship_state TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS first_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS second_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS first_state_updated_at_ms BIGINT,
    ADD COLUMN IF NOT EXISTS second_state_updated_at_ms BIGINT,
    ADD COLUMN IF NOT EXISTS lifecycle_revision BIGINT NOT NULL DEFAULT 1;`,
  `ALTER TABLE icp_dyads DROP CONSTRAINT IF EXISTS icp_dyads_status_check;`,
  `DO $migration$
  DECLARE constraint_name TEXT;
  BEGIN
    FOR constraint_name IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'icp_dyads'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%closed_at_ms%close_reason_code%'
    LOOP
      EXECUTE format('ALTER TABLE icp_dyads DROP CONSTRAINT %I', constraint_name);
    END LOOP;
  END
  $migration$;`,
  `UPDATE icp_dyads SET
    first_relationship_state = CASE WHEN status = 'closed' THEN 'closed' ELSE 'open' END,
    second_relationship_state = CASE WHEN status = 'closed' THEN 'closed' ELSE 'open' END,
    first_blocked = status = 'revoked' AND close_reason_code <> 'conversation_suppressed',
    second_blocked = status = 'revoked' AND close_reason_code <> 'conversation_suppressed',
    first_state_updated_at_ms = COALESCE(closed_at_ms, created_at_ms),
    second_state_updated_at_ms = COALESCE(closed_at_ms, created_at_ms),
    status = CASE
      WHEN status = 'revoked' AND close_reason_code <> 'conversation_suppressed' THEN 'blocked'
      WHEN status = 'closed' THEN 'closed'
      ELSE 'open'
    END,
    closed_at_ms = NULL,
    close_reason_code = NULL
  WHERE first_state_updated_at_ms IS NULL OR second_state_updated_at_ms IS NULL;`,
  // Keep migration 16 compatible with an N-1 writer during a rolling upgrade.
  // The legacy insert supplies created_at_ms but does not know these columns;
  // the database clock is evaluated after that supplied timestamp and therefore
  // remains valid under the participant-state >= created_at_ms constraint.
  `ALTER TABLE icp_dyads
    ALTER COLUMN first_state_updated_at_ms SET DEFAULT
      ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT),
    ALTER COLUMN second_state_updated_at_ms SET DEFAULT
      ((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);`,
  `ALTER TABLE icp_dyads ALTER COLUMN first_state_updated_at_ms SET NOT NULL;`,
  `ALTER TABLE icp_dyads ALTER COLUMN second_state_updated_at_ms SET NOT NULL;`,
  `ALTER TABLE icp_dyads DROP CONSTRAINT IF EXISTS icp_dyads_participant_state_check;`,
  `ALTER TABLE icp_dyads ADD CONSTRAINT icp_dyads_status_check
    CHECK (status IN ('open', 'paused', 'closed', 'blocked'));`,
  `ALTER TABLE icp_dyads ADD CONSTRAINT icp_dyads_participant_state_check CHECK (
    first_relationship_state IN ('open', 'paused', 'closed')
    AND second_relationship_state IN ('open', 'paused', 'closed')
    AND first_state_updated_at_ms >= created_at_ms
    AND second_state_updated_at_ms >= created_at_ms
    AND lifecycle_revision >= 1
    AND status = CASE
      WHEN first_blocked OR second_blocked THEN 'blocked'
      WHEN first_relationship_state = 'closed' OR second_relationship_state = 'closed' THEN 'closed'
      WHEN first_relationship_state = 'paused' OR second_relationship_state = 'paused' THEN 'paused'
      ELSE 'open'
    END
  );`,
  `ALTER TABLE icp_dyad_deliveries
    ADD COLUMN IF NOT EXISTS dyad_lifecycle_revision BIGINT;`,
  `UPDATE icp_dyad_deliveries AS delivery
    SET dyad_lifecycle_revision = dyad.lifecycle_revision
    FROM icp_dyads AS dyad
    WHERE delivery.dyad_id = dyad.dyad_id AND delivery.dyad_lifecycle_revision IS NULL;`,
  `ALTER TABLE icp_dyad_deliveries ALTER COLUMN dyad_lifecycle_revision SET NOT NULL;`,
  `ALTER TABLE icp_dyad_deliveries
    DROP CONSTRAINT IF EXISTS icp_dyad_deliveries_lifecycle_revision_check;`,
  `ALTER TABLE icp_dyad_deliveries ADD CONSTRAINT icp_dyad_deliveries_lifecycle_revision_check
    CHECK (dyad_lifecycle_revision >= 1);`,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (16, 'icp-dyad-participant-lifecycle')
    ON CONFLICT (version) DO NOTHING;`,
  // Version 17 (y0bft.4): one cluster-wide, content-free scheduling authority
  // for heavy nighttime maintenance. Private work and memory content remain in
  // each companion schema; shared state carries only identities, ordinals,
  // deadlines, an opaque checkpoint reference, and a monotonic fencing token.
  `CREATE TABLE IF NOT EXISTS fleet_maintenance_baton (
    scope TEXT PRIMARY KEY CHECK (scope = 'heavy_nighttime_maintenance'),
    manifest_fingerprint TEXT,
    fleet_size INTEGER NOT NULL DEFAULT 0 CHECK (fleet_size >= 0),
    holder_companion_id UUID,
    holder_instance_id UUID,
    fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    acquired_at_ms BIGINT,
    lease_expires_at_ms BIGINT,
    phase TEXT,
    preempt_requested BOOLEAN NOT NULL DEFAULT FALSE,
    last_served_ordinal INTEGER NOT NULL DEFAULT -1 CHECK (last_served_ordinal >= -1),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK ((fleet_size = 0) = (manifest_fingerprint IS NULL)),
    CHECK (manifest_fingerprint IS NULL OR manifest_fingerprint ~ '^[0-9a-f]{64}$'),
    CHECK (last_served_ordinal < fleet_size OR fleet_size = 0),
    CHECK ((holder_companion_id IS NULL) = (acquired_at_ms IS NULL)),
    CONSTRAINT fleet_maintenance_baton_holder_instance_check
      CHECK ((holder_companion_id IS NULL) = (holder_instance_id IS NULL)),
    CHECK ((holder_companion_id IS NULL) = (lease_expires_at_ms IS NULL)),
    CHECK ((holder_companion_id IS NULL) = (phase IS NULL)),
    CHECK (holder_companion_id IS NOT NULL OR preempt_requested = FALSE),
    CHECK (phase IS NULL OR char_length(phase) BETWEEN 1 AND 128),
    CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms > acquired_at_ms)
  );`,
  `INSERT INTO fleet_maintenance_baton (scope)
    VALUES ('heavy_nighttime_maintenance')
    ON CONFLICT (scope) DO NOTHING;`,
  `CREATE TABLE IF NOT EXISTS fleet_maintenance_demands (
    scope TEXT NOT NULL CHECK (scope = 'heavy_nighttime_maintenance'),
    companion_id UUID NOT NULL,
    manifest_fingerprint TEXT NOT NULL CHECK (manifest_fingerprint ~ '^[0-9a-f]{64}$'),
    manifest_ordinal INTEGER NOT NULL CHECK (manifest_ordinal >= 0),
    fleet_size INTEGER NOT NULL CHECK (fleet_size > 0),
    requested_at_ms BIGINT NOT NULL CHECK (requested_at_ms >= 0),
    ready_until_ms BIGINT NOT NULL CHECK (ready_until_ms > requested_at_ms),
    PRIMARY KEY (scope, companion_id),
    UNIQUE (scope, manifest_fingerprint, manifest_ordinal),
    CHECK (manifest_ordinal < fleet_size)
  );`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_maintenance_demand_order
    ON fleet_maintenance_demands (
      scope, manifest_fingerprint, manifest_ordinal, ready_until_ms
    );`,
  `CREATE TABLE IF NOT EXISTS fleet_maintenance_checkpoints (
    scope TEXT NOT NULL CHECK (scope = 'heavy_nighttime_maintenance'),
    companion_id UUID NOT NULL,
    phase TEXT NOT NULL CHECK (char_length(phase) BETWEEN 1 AND 128),
    checkpoint_ref TEXT CHECK (
      checkpoint_ref IS NULL OR char_length(checkpoint_ref) BETWEEN 1 AND 512
    ),
    fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (scope, companion_id)
  );`,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (17, 'fleet-heavy-maintenance-baton')
    ON CONFLICT (version) DO NOTHING;`,
  // Version 18: a live lease is owned by one opaque coordinator instance, not
  // merely by a companion. Clear any version-17 live lease before installing
  // the invariant so rolling upgrades fail closed instead of sharing a token.
  `ALTER TABLE fleet_maintenance_baton
    ADD COLUMN IF NOT EXISTS holder_instance_id UUID;`,
  `UPDATE fleet_maintenance_baton
    SET holder_companion_id = NULL, holder_instance_id = NULL,
        acquired_at_ms = NULL, lease_expires_at_ms = NULL, phase = NULL,
        preempt_requested = FALSE, revision = revision + 1
    WHERE holder_companion_id IS NOT NULL AND holder_instance_id IS NULL;`,
  `ALTER TABLE fleet_maintenance_baton
    DROP CONSTRAINT IF EXISTS fleet_maintenance_baton_holder_instance_check;`,
  `ALTER TABLE fleet_maintenance_baton
    ADD CONSTRAINT fleet_maintenance_baton_holder_instance_check
    CHECK ((holder_companion_id IS NULL) = (holder_instance_id IS NULL));`,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (18, 'fleet-maintenance-process-fencing')
    ON CONFLICT (version) DO NOTHING;`,
  // Version 19 (sprint 12, jp36.5.5): the bounded durable room-participation
  // lease. One companion's membership in one verified group room: while it is
  // active an ordinary room message that never repeats the companion's name may
  // still become a contextual continuation candidate for the existing cheap
  // appraiser. It grants consideration only — the reservation and egress leases
  // above still own appraisal and the single send.
  //
  // `watermark_*` is the context watermark: the newest already-considered room
  // message. Continuation admission advances it in ONE atomic conditional
  // update, so a message is considered at most once even across a restart, a
  // redelivery, or two racing observers (acceptance jp36.5.5 #4). Content-free
  // by construction: ids, counters, timestamps, and bounded reason codes only —
  // no room text ever lands in the shared schema.
  `
  CREATE TABLE IF NOT EXISTS room_participation_leases (
    companion_id UUID NOT NULL,
    channel_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    opened_disposition TEXT NOT NULL CHECK (opened_disposition IN (
      'direct_summons', 'passive_summons', 'reaction', 'reply',
      'endogenous_room_entry'
    )),
    opened_at_ms BIGINT NOT NULL CHECK (opened_at_ms >= 0),
    last_activity_at_ms BIGINT NOT NULL CHECK (last_activity_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > opened_at_ms),
    watermark_message_id TEXT NOT NULL,
    watermark_timestamp_ms BIGINT NOT NULL CHECK (watermark_timestamp_ms >= 0),
    considered_count INTEGER NOT NULL DEFAULT 0 CHECK (considered_count >= 0),
    ignore_streak INTEGER NOT NULL DEFAULT 0 CHECK (ignore_streak >= 0),
    machine_streak INTEGER NOT NULL DEFAULT 0 CHECK (machine_streak >= 0),
    closed_at_ms BIGINT,
    close_reason TEXT CHECK (close_reason IN (
      'expiry', 'silence', 'message_cap', 'machine_streak', 'withdrawn',
      'fatigue', 'room_pressure', 'policy_off'
    )),
    revision BIGINT NOT NULL CHECK (revision >= 1),
    PRIMARY KEY (companion_id, channel_id),
    CONSTRAINT room_participation_leases_lifecycle_check
      CHECK ((status = 'closed') = (closed_at_ms IS NOT NULL)),
    CONSTRAINT room_participation_leases_close_reason_presence_check
      CHECK ((status = 'closed') = (close_reason IS NOT NULL))
  );
  `,
  // Active leases per room: the contention read for "who else is considering
  // this conversation", and the sweep index for lapsed membership.
  `CREATE INDEX IF NOT EXISTS idx_room_participation_leases_active_channel
    ON room_participation_leases (channel_id, expires_at_ms) WHERE status = 'active';`,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (19, 'room-participation-lease')
    ON CONFLICT (version) DO NOTHING;`,
  // Version 20 (sprint 12, psfn-framework-h248l.9): the non-expiring lifecycle
  // ADMISSION bit, added to the existing per-companion invalidation-fence row
  // rather than to a parallel membership registry.
  //
  // The generation below it is a freshness fence: it says "your captured view
  // is stale", and a caller that re-captures immediately is admitted again.
  // That is exactly wrong for companion removal — an unattended crash between
  // "revoke permits" and "scale the workload down" leaves a window in which the
  // removed companion captures the current generation and is admitted. This bit
  // never expires and never clears implicitly, so removal survives the crash,
  // the restart, and any amount of delay: permit issue/consume read it under the
  // SAME `FOR UPDATE` row lock as the generation and refuse a fenced
  // participant even against a freshly captured generation.
  //
  // Additive and safe on a live deployment: NOT NULL DEFAULT false is a
  // metadata-only rewrite on modern PostgreSQL, and every existing row means
  // "admitted", which is the pre-migration behavior exactly.
  `ALTER TABLE icp_autonomy_invalidation_fences
    ADD COLUMN IF NOT EXISTS lifecycle_fenced BOOLEAN NOT NULL DEFAULT false;`,
  // Every lifecycle transition (fence AND clear) advances the generation and
  // stamps evidence, so a fenced row can never sit at the pristine generation 0.
  `ALTER TABLE icp_autonomy_invalidation_fences
    DROP CONSTRAINT IF EXISTS icp_autonomy_invalidation_fences_lifecycle_evidence_check;`,
  `ALTER TABLE icp_autonomy_invalidation_fences
    ADD CONSTRAINT icp_autonomy_invalidation_fences_lifecycle_evidence_check
      CHECK (NOT lifecycle_fenced OR generation > 0);`,
  // The reconciler's "who is currently denied admission" read.
  `CREATE INDEX IF NOT EXISTS idx_icp_autonomy_invalidation_fences_lifecycle_fenced
    ON icp_autonomy_invalidation_fences (companion_id) WHERE lifecycle_fenced;`,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (20, 'icp-lifecycle-admission-fence')
    ON CONFLICT (version) DO NOTHING;`,
  // Version 21 (bead psfn-framework-e5r0s): the fleet's SYSTEM-owned health
  // stream and escalation ledger.
  //
  // Every other table in this chain is shared because the thing it describes is
  // shared. These two are here for a narrower reason: the gateway and each
  // agent persist observations into their own pool scope, and in fleet mode
  // those are different schemas — so a Postgres pool storm the gateway saw, and
  // the escalation it raised, were invisible in every companion's Garden. The
  // gateway writes its system-owned rows here instead, and each companion's
  // Garden reads them beside its own tenant rows.
  //
  // The DDL is the SAME statement list a per-companion runtime installs in its
  // own schema, shared from one definition above, so the projection can never
  // drift out of readability. What differs is only who writes. These rows are
  // MOSTLY system-owned — but one gateway screens for the whole fleet, so a
  // quarantine hold it makes for one companion is raised here carrying THAT
  // companion's ownership. The reading services fence on owner, and that fence
  // is the guarantee that a companion's Garden sees the runtime's faults and
  // its own and nothing else.
  //
  // Version 20 above is the ICP lifecycle admission fence; the two landed from
  // parallel lanes and are independent.
  ...RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS,
  ...HUMAN_ESCALATION_TABLE_STATEMENTS,
  `INSERT INTO shared_schema_migrations (version, name)
    VALUES (21, 'fleet-system-health-and-escalations')
    ON CONFLICT (version) DO NOTHING;`,
];

// Version 3 (sprint 10, s10f9): shared-world wiki chunk projection. A
// rebuildable pgvector mirror of the shared-world wiki filesystem tree
// (<system-data>/shared-world/wiki/sites/<siteId>/) so companion retrieval can
// serve `shared_world:<siteId>` scopes. The filesystem documents remain the
// source of truth; rows are keyed by (site_id, document_id, chunk_index) and
// carry body_sha256 so drift is detectable and the projection is rebuilt
// per-site from the canonical files (delete-and-replace per document version).
//
// This lives in its OWN statement list, deliberately NOT appended to
// POSTGRES_SHARED_MIGRATIONS: it requires the pgvector extension, and the base
// shared chain must stay runnable on a plain Postgres so pgvector-free shared
// consumers (companion_presence) never grow a hidden extension dependency.
// Gateway startup provisions it after the base chain under the same advisory
// lock, registering versions 3 and 8 in the same shared_schema_migrations ledger.
// Ordinary runtime wiki surfaces only verify that the complete chain exists.
//
// Column shape mirrors the per-companion `wiki_document_chunks` table closely
// (plus site_id) so chunk query code stays uniform across both projections.
// The CHECK ties scope to site_id at the database layer: a personal-scoped (or
// cross-site mis-scoped) row can never land in the shared table — that is the
// W5b world-info leak surface, enforced fail-closed in the schema itself.
export const POSTGRES_SHARED_WIKI_MIGRATIONS: readonly string[] = [
  // Deterministic extension placement: shared migrations run with search_path
  // pinned to `shared, extensions`, and shared/per-companion chains alike
  // resolve vector types without exposing legacy public tenant objects.
  POSTGRES_VECTOR_EXTENSION_MIGRATION,
  `
  CREATE TABLE IF NOT EXISTS shared_wiki_chunks (
    site_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    body_sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    body_path TEXT NOT NULL,
    source_class TEXT NOT NULL,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    scope TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_char_count INTEGER NOT NULL,
    embedding VECTOR NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (site_id, document_id, chunk_index),
    CHECK (scope = 'shared_world:' || site_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_shared_wiki_chunks_site ON shared_wiki_chunks(site_id);`,
  `CREATE INDEX IF NOT EXISTS idx_shared_wiki_chunks_scope ON shared_wiki_chunks(scope);`,
  `
  CREATE TABLE IF NOT EXISTS shared_wiki_proposals (
    proposal_id UUID PRIMARY KEY,
    site_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    provenance_refs_json JSONB NOT NULL,
    sensitivity TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    review_state TEXT NOT NULL DEFAULT 'pending',
    rejection_code TEXT,
    reviewed_by TEXT,
    reviewed_at_ms BIGINT,
    apply_state TEXT NOT NULL DEFAULT 'unreviewed',
    apply_lease_token UUID,
    apply_lease_until_ms BIGINT,
    applied_at_ms BIGINT,
    applied_document_version INTEGER,
    applied_body_sha256 TEXT,
    projection_body_sha256 TEXT,
    cleanup_checked_at_ms BIGINT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    UNIQUE (site_id, content_digest),
    CHECK (review_state IN ('pending', 'approved', 'rejected')),
    CHECK (apply_state IN ('unreviewed', 'ready', 'applying', 'retryable', 'applied', 'rejected')),
    CHECK (sensitivity = 'public'),
    CHECK (jsonb_typeof(tags_json) = 'array'),
    CHECK (jsonb_typeof(provenance_refs_json) = 'array'),
    CHECK (
      (review_state = 'pending' AND reviewed_by IS NULL AND reviewed_at_ms IS NULL AND rejection_code IS NULL)
      OR (review_state = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at_ms IS NOT NULL AND rejection_code IS NULL)
      OR (review_state = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at_ms IS NOT NULL AND rejection_code IS NOT NULL)
    ),
    CHECK (
      (apply_state = 'applying' AND apply_lease_token IS NOT NULL AND apply_lease_until_ms IS NOT NULL)
      OR (apply_state <> 'applying' AND apply_lease_token IS NULL AND apply_lease_until_ms IS NULL)
    ),
    CHECK ((review_state = 'approved') OR apply_state IN ('unreviewed', 'rejected')),
    CHECK ((review_state = 'rejected') = (apply_state = 'rejected'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_shared_wiki_proposals_review ON shared_wiki_proposals(review_state, created_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_shared_wiki_proposals_apply ON shared_wiki_proposals(apply_state, apply_lease_until_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_shared_wiki_proposals_cleanup ON shared_wiki_proposals(cleanup_checked_at_ms NULLS FIRST) WHERE review_state = 'approved' AND apply_state = 'applied';`,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (3, 'shared-wiki-chunks')
  ON CONFLICT (version) DO NOTHING;
  `,
  `
  INSERT INTO shared_schema_migrations (version, name)
  VALUES (8, 'shared-wiki-caretaker-proposals')
  ON CONFLICT (version) DO NOTHING;
  `,
];

// ── Partner Affect shadow observations (docs/partner-affect.md slice 1) ──
//
// Shadow-only evidence store: accepted Signal Observations (summarized
// scalars + provenance handles only — raw sensitive content is rejected at
// the guard boundary and can never reach these tables) and structural
// suppression audit records. Idempotency key is (source_id, observation_id).
export const POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS partner_affect_shadow_observations (
    observation_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    observation_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    partner_contact_id TEXT NOT NULL,
    signal_family TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT NOT NULL,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    observed_at_ms BIGINT NOT NULL,
    coverage DOUBLE PRECISION NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    missingness DOUBLE PRECISION NOT NULL,
    direction TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    consent_ref TEXT NOT NULL,
    assertion TEXT NOT NULL,
    provenance_json JSONB NOT NULL,
    processing_revision TEXT NOT NULL,
    received_at_ms BIGINT NOT NULL,
    UNIQUE (source_id, observation_id),
    CHECK (window_start_ms >= 0 AND window_end_ms >= window_start_ms),
    CHECK (coverage >= 0 AND coverage <= 1),
    CHECK (confidence >= 0 AND confidence <= 1),
    CHECK (missingness >= 0 AND missingness <= 1),
    CHECK (direction IN ('higher_supports_need', 'lower_supports_need', 'unknown')),
    CHECK (assertion IN ('partner_asserted', 'model_inferred', 'sensor_summary', 'unverified')),
    CHECK (jsonb_typeof(provenance_json) = 'array'),
    CHECK (provenance_json <> '[]'::jsonb),
    CHECK (octet_length(provenance_json::text) <= 16384)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_partner_affect_shadow_obs_partner_observed
    ON partner_affect_shadow_observations(partner_contact_id, observed_at_ms DESC, observation_key DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS partner_affect_shadow_suppressions (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    observation_key TEXT,
    source_id TEXT,
    signal_family TEXT,
    partner_contact_id TEXT,
    reasons_json JSONB NOT NULL,
    detail TEXT NOT NULL,
    received_at_ms BIGINT NOT NULL,
    CHECK (jsonb_typeof(reasons_json) = 'array'),
    CHECK (reasons_json <> '[]'::jsonb),
    CHECK (octet_length(reasons_json::text) <= 4096),
    CHECK (octet_length(detail) <= 4096)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_partner_affect_shadow_suppressions_received
    ON partner_affect_shadow_suppressions(partner_contact_id, received_at_ms DESC, id DESC);
  `,
];

/**
 * The bounded health-event ring a per-companion runtime opens in its own
 * schema. Identical DDL to the shared-schema copy (shared migration version
 * 21), from one definition.
 */
export const POSTGRES_HEALTH_EVENT_MIGRATIONS: readonly string[] =
  RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS;

/**
 * The durable human escalation ledger a per-companion runtime opens in its own
 * schema. Identical DDL to the shared-schema copy the fleet's system-owned
 * escalations live in (shared migration version 21) — one definition, so the
 * two can never drift into a projection that cannot be read back.
 */
export const POSTGRES_HUMAN_ESCALATION_MIGRATIONS: readonly string[] =
  HUMAN_ESCALATION_TABLE_STATEMENTS;

// Analysis-workbench trace ring (bead vb11). Persists the redacted
// AnalysisWorkbenchTraceView projection so the Garden /analysis-workbench page
// survives a Garden/agent restart. Companion-scoped, bounded per companion to
// the same 50-entry window the in-memory ring uses; the redacted projection is
// stored verbatim as JSONB and read back newest-first.
export const POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS analysis_workbench_traces (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    trace_json JSONB NOT NULL,
    CHECK (recorded_at_ms >= 0),
    CHECK (jsonb_typeof(trace_json) = 'object'),
    CHECK (octet_length(trace_json::text) <= 1048576)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_analysis_workbench_traces_companion_recorded
    ON analysis_workbench_traces(companion_id, recorded_at_ms DESC, id DESC);
  `,
];

/** Companion-private asynchronous correspondence bin (S12A Letters). */
export const POSTGRES_LETTER_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS letters (
    id UUID PRIMARY KEY,
    author_kind TEXT NOT NULL,
    recipient_kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    placed_at_ms BIGINT,
    read_at_ms BIGINT,
    archived_at_ms BIGINT,
    CHECK (author_kind IN ('companion', 'partner')),
    CHECK (recipient_kind IN ('companion', 'partner')),
    CHECK (author_kind <> recipient_kind),
    CHECK (state IN ('draft', 'placed', 'read', 'archived')),
    CHECK (length(btrim(subject)) > 0),
    CHECK (length(btrim(body)) > 0),
    CHECK (created_at_ms >= 0 AND updated_at_ms >= created_at_ms),
    CHECK ((state = 'draft' AND placed_at_ms IS NULL) OR state <> 'draft'),
    CHECK ((state IN ('read', 'archived') AND read_at_ms IS NOT NULL) OR state NOT IN ('read', 'archived')),
    CHECK ((state = 'archived' AND archived_at_ms IS NOT NULL) OR state <> 'archived')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_letters_recipient_state_updated
    ON letters(recipient_kind, state, updated_at_ms DESC, id DESC);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_letters_author_updated
    ON letters(author_kind, updated_at_ms DESC, id DESC);
  `,
];

/** Companion-private doing-mirror disposition and durable Letter-delivery outbox. */
export const POSTGRES_DOING_MIRROR_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS doing_mirror_dispositions (
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    version INTEGER NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    updated_by TEXT NOT NULL,
    letter_id UUID NOT NULL UNIQUE,
    letter_subject TEXT NOT NULL,
    letter_body TEXT NOT NULL,
    letter_delivered_at_ms BIGINT,
    PRIMARY KEY (item_type, item_id),
    CHECK (item_type IN ('wishlist', 'fold_package')),
    CHECK (length(btrim(item_id)) > 0),
    CHECK (state IN ('considering', 'done', 'declined')),
    CHECK (reason IS NULL OR length(btrim(reason)) > 0),
    CHECK (state <> 'declined' OR reason IS NOT NULL),
    CHECK (version >= 1),
    CHECK (updated_at_ms >= 0),
    CHECK (updated_by = 'partner'),
    CHECK (length(btrim(letter_subject)) > 0),
    CHECK (length(btrim(letter_body)) > 0),
    CHECK (letter_delivered_at_ms IS NULL OR letter_delivered_at_ms >= updated_at_ms)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_doing_mirror_dispositions_updated
    ON doing_mirror_dispositions(updated_at_ms DESC, item_type, item_id);
  `,
  // psfn-framework-nwtw1: consecutive delivery-failure bookkeeping so a
  // permanently failing row is quarantined out of the bounded drain batch
  // instead of starving every newer pending Letter. PostgreSQL has no
  // `ADD CONSTRAINT IF NOT EXISTS` and a drop/add pair would revalidate the
  // whole table on every store connect, so the pairing invariant (a non-zero
  // count always carries its last error and failure timestamp) is enforced in
  // PostgresDoingMirrorStore's row mapper and writes instead.
  `
  ALTER TABLE doing_mirror_dispositions
    ADD COLUMN IF NOT EXISTS letter_failure_count INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE doing_mirror_dispositions
    ADD COLUMN IF NOT EXISTS letter_last_error TEXT;
  `,
  `
  ALTER TABLE doing_mirror_dispositions
    ADD COLUMN IF NOT EXISTS letter_last_failed_at_ms BIGINT;
  `,
  `
  ALTER TABLE doing_mirror_dispositions
    ADD COLUMN IF NOT EXISTS letter_quarantined_at_ms BIGINT;
  `,
  // The drain must skip quarantined rows, so the pending index carries the same
  // predicate. The pre-quarantine index is replaced rather than kept beside it.
  `
  DROP INDEX IF EXISTS idx_doing_mirror_pending_letters;
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_doing_mirror_drainable_letters
    ON doing_mirror_dispositions(updated_at_ms, item_type, item_id)
    WHERE letter_delivered_at_ms IS NULL AND letter_quarantined_at_ms IS NULL;
  `,
];

/** Companion-private durable class/run/session discovery for ephemeral workers. */
export const POSTGRES_AUTOMATA_RUN_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS automata_runs (
    companion_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    automaton_class TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    worker_generation INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    task_label TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    parent_run_id TEXT,
    source_run_id TEXT,
    session_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL,
    status_reason TEXT NOT NULL,
    outcome TEXT,
    failure_reason TEXT,
    promotion_state TEXT NOT NULL DEFAULT 'not_requested',
    fold_state TEXT NOT NULL DEFAULT 'not_required',
    created_at_ms BIGINT NOT NULL,
    started_at_ms BIGINT,
    finished_at_ms BIGINT,
    retention_deadline_ms BIGINT NOT NULL,
    PRIMARY KEY (companion_id, run_id),
    CHECK (worker_generation >= 1),
    CHECK (jsonb_typeof(session_ids_json) = 'array'),
    CHECK (jsonb_typeof(artifacts_json) = 'array'),
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK (outcome IS NULL OR outcome IN ('completed', 'blocked', 'cancelled', 'budget_limited')),
    CHECK (promotion_state IN ('not_requested', 'pending', 'promoted', 'rejected')),
    CHECK (fold_state IN ('not_required', 'pending', 'folded', 'rejected')),
    CHECK (retention_deadline_ms > created_at_ms),
    CHECK ((status IN ('queued', 'running') AND finished_at_ms IS NULL) OR status IN ('completed', 'failed', 'cancelled'))
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_status_created
    ON automata_runs(companion_id, status, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_task_created
    ON automata_runs(companion_id, task_id, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_companion_class_created
    ON automata_runs(companion_id, automaton_class, created_at_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_automata_runs_retention
    ON automata_runs(companion_id, retention_deadline_ms);`,
];

/** One ordered migration head for the run authority and its append-only Bus. */
export const POSTGRES_AUTOMATA_MIGRATIONS: readonly string[] = [
  // The Bus vector relation is part of this independently executable migration
  // head (PostgresAutomataRunStore.connect runs it without memory migrations).
  // Install or validate pgvector before any VECTOR-typed Bus DDL is parsed.
  POSTGRES_VECTOR_EXTENSION_MIGRATION,
  ...POSTGRES_AUTOMATA_RUN_MIGRATIONS,
  ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
  ...AUTOMATA_RETENTION_POSTGRES_SCHEMA_STATEMENTS,
  ...AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS,
];

/** Roll back only the dependent Bus slice, preserving the run authority. */
export const POSTGRES_AUTOMATA_ROLLBACK_MIGRATIONS: readonly string[] = [
  ...AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS,
  ...AUTOMATA_RETENTION_POSTGRES_ROLLBACK_STATEMENTS,
  ...AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
];

/**
 * Content-addressed CogSec admission receipts (psfn-framework-1fjvm.3). The
 * canonical receipt lives in `receipt_json` and is re-validated on every read;
 * the extracted columns exist only so lookup by (exact bytes × exact screening
 * contract) is an index hit. Rows accumulate per issuance — a later receipt
 * never rewrites an earlier one — and lookup takes the newest.
 */
export const POSTGRES_COGSEC_RECEIPT_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS cogsec_receipts (
    receipt_id TEXT PRIMARY KEY,
    content_sha256 TEXT NOT NULL,
    raw_content_sha256 TEXT NOT NULL,
    screening_contract_digest TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    issuer_instance TEXT NOT NULL,
    envelope_id TEXT NOT NULL,
    verdict_action TEXT NOT NULL,
    issued_at_ms BIGINT NOT NULL,
    expires_at_ms BIGINT NOT NULL,
    receipt_json JSONB NOT NULL,
    CHECK (length(btrim(receipt_id)) > 0),
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (raw_content_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (screening_contract_digest ~ '^[a-f0-9]{64}$'),
    CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (length(btrim(issuer_id)) > 0),
    CHECK (length(btrim(issuer_instance)) > 0),
    CHECK (length(btrim(envelope_id)) > 0),
    CHECK (verdict_action IN ('pass', 'sanitize')),
    CHECK (issued_at_ms > 0),
    CHECK (expires_at_ms > issued_at_ms),
    CHECK (jsonb_typeof(receipt_json) = 'object')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_cogsec_receipts_content_contract
    ON cogsec_receipts(content_sha256, screening_contract_digest, issued_at_ms DESC, receipt_id DESC);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_cogsec_receipts_expiry
    ON cogsec_receipts(expires_at_ms);
  `,
];

/**
 * Blind Reviewer rolling review window (bead psfn-framework-yxz0z.3).
 *
 * The window is deliberately durable rather than in-process: restart recovery,
 * the unchanged-batch gate, and retention expiry all depend on knowing what was
 * already ingested and already reviewed. `pinned_case_id` is the whole pinning
 * mechanism — retention deletes only rows where it is NULL, so evidence an
 * operator alert asks someone to investigate outlives the retention clock while
 * ordinary evidence does not.
 *
 * Only reduced evidence is storable by construction: `blinded_excerpt` is
 * non-empty exactly when the row is `blinded_excerpt`-classed, and a
 * `structural_only` row is constrained to carry no text at all.
 */
export const POSTGRES_COGSEC_BLIND_REVIEW_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS cogsec_blind_review_evidence (
    evidence_id TEXT PRIMARY KEY,
    source_ref TEXT NOT NULL,
    occurred_at_ms BIGINT NOT NULL,
    captured_at_ms BIGINT NOT NULL,
    disclosure TEXT NOT NULL,
    activity_json JSONB NOT NULL,
    blinded_excerpt TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    reviewed_at_ms BIGINT,
    pinned_case_id TEXT,
    pinned_at_ms BIGINT,
    CHECK (evidence_id ~ '^[a-f0-9]{32}$'),
    CHECK (content_digest ~ '^[a-f0-9]{64}$'),
    CHECK (length(btrim(source_ref)) > 0),
    CHECK (occurred_at_ms > 0),
    CHECK (captured_at_ms > 0),
    CHECK (disclosure IN ('structural_only', 'blinded_excerpt')),
    CHECK (jsonb_typeof(activity_json) = 'object'),
    CHECK (
      (disclosure = 'structural_only' AND blinded_excerpt = '')
      OR (disclosure = 'blinded_excerpt' AND length(blinded_excerpt) > 0)
    ),
    CHECK ((pinned_case_id IS NULL) = (pinned_at_ms IS NULL)),
    CHECK (pinned_case_id IS NULL OR pinned_case_id ~ '^cogsec_[A-Za-z0-9_-]+$')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_cogsec_blind_review_unreviewed
    ON cogsec_blind_review_evidence(occurred_at_ms, evidence_id)
    WHERE reviewed_at_ms IS NULL;
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_cogsec_blind_review_retention
    ON cogsec_blind_review_evidence(occurred_at_ms)
    WHERE pinned_case_id IS NULL;
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_cogsec_blind_review_pinned_case
    ON cogsec_blind_review_evidence(pinned_case_id)
    WHERE pinned_case_id IS NOT NULL;
  `,
  `
  CREATE TABLE IF NOT EXISTS cogsec_blind_review_state (
    processor TEXT PRIMARY KEY,
    ingested_through_ms BIGINT NOT NULL,
    last_batch_digest TEXT,
    review_attempt INTEGER NOT NULL,
    retry_not_before_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    CHECK (length(btrim(processor)) > 0),
    CHECK (ingested_through_ms >= 0),
    CHECK (review_attempt >= 0),
    CHECK (retry_not_before_ms >= 0),
    CHECK (last_batch_digest IS NULL OR last_batch_digest ~ '^[a-f0-9]{64}$')
  );
  `,
  // ── Gate savings counter (bead psfn-framework-33xah) ──
  //
  // How many model calls the deterministic change gate has refused over the
  // lane's whole life, and when it last refused one. The lane's acceptance
  // criterion is "an unchanged or undersized batch costs zero model calls";
  // without a durable cumulative counter that claim is unfalsifiable from
  // Garden, because a per-pass number is gone the moment the pass ends.
  //
  // Additive and backfill-free on purpose: `ADD COLUMN IF NOT EXISTS` with a
  // zero default upgrades a deployment that already carries lane state — the
  // existing row reads as "the gate has saved nothing yet", which is the honest
  // answer for a counter that did not exist while those savings happened. A
  // companion-schema chain has no version ledger (`shared_schema_migrations` is
  // the shared schema's), so idempotent statements appended here ARE the
  // migration, exactly as `agent_background_work_jobs` does it.
  `ALTER TABLE cogsec_blind_review_state ADD COLUMN IF NOT EXISTS model_calls_avoided BIGINT NOT NULL DEFAULT 0;`,
  // 0 means "never", not "the epoch": the counter and its clock start together,
  // so a zero count can never carry a non-zero timestamp.
  `ALTER TABLE cogsec_blind_review_state ADD COLUMN IF NOT EXISTS model_calls_avoided_at_ms BIGINT NOT NULL DEFAULT 0;`,
  // `CREATE TABLE IF NOT EXISTS` never revisits an existing table's
  // constraints, so the floor for these two columns is installed the way every
  // other post-hoc CHECK in this file is: dropped by name, then re-added.
  `ALTER TABLE cogsec_blind_review_state
    DROP CONSTRAINT IF EXISTS cogsec_blind_review_state_model_calls_avoided_check;`,
  `ALTER TABLE cogsec_blind_review_state
    ADD CONSTRAINT cogsec_blind_review_state_model_calls_avoided_check
      CHECK (model_calls_avoided >= 0);`,
  `ALTER TABLE cogsec_blind_review_state
    DROP CONSTRAINT IF EXISTS cogsec_blind_review_state_model_calls_avoided_at_ms_check;`,
  `ALTER TABLE cogsec_blind_review_state
    ADD CONSTRAINT cogsec_blind_review_state_model_calls_avoided_at_ms_check
      CHECK (
        model_calls_avoided_at_ms >= 0
        AND (model_calls_avoided > 0 OR model_calls_avoided_at_ms = 0)
      );`,
];

// ── Durable per-turn CogSec custody snapshots (psfn-framework-ccgdz.1) ──
//
// One row per generation context (`turn:<turnId>`) — the lineage's own key, so
// no new identifier is minted. `snapshot_json` is the canonical document; every
// read re-validates it through `validateCustodySnapshot`, so a row edited in
// the database is a load failure rather than a quiet custody claim.
//
// The CHECK constraints below are the content-free floor: only closed
// vocabularies, structurally bounded identifiers, lowercase-hex digests, and
// non-negative counts can reach a column. Retention is operator-owned
// (`settings.json` `custodySnapshotRetentionDays`) and enforced by the store.
export const POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS custody_snapshots (
    generation_context_ref TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    classification TEXT NOT NULL,
    effective_sensitivity TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    has_unclassified_source BOOLEAN NOT NULL,
    classifier_version TEXT NOT NULL,
    classified_at_ms BIGINT NOT NULL,
    content_sha256 TEXT NOT NULL,
    snapshot_json JSONB NOT NULL,
    CHECK (generation_context_ref = 'turn:' || turn_id),
    CHECK (turn_id ~ '^[A-Za-z0-9_:.@+-]{1,128}$'),
    CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (classification IN ('auto_shareable', 'restricted', 'approval_required', 'non_shareable')),
    CHECK (effective_sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
    CHECK (source_count >= 0),
    CHECK (classifier_version ~ '^[A-Za-z0-9_./-]{1,64}$'),
    CHECK (classified_at_ms > 0),
    CHECK (jsonb_typeof(snapshot_json) = 'object')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_custody_snapshots_turn
    ON custody_snapshots(turn_id);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_custody_snapshots_classified_at
    ON custody_snapshots(classified_at_ms);
  `,
  // ccgdz.4: the per-block context source manifest lives beside the snapshot
  // under the same `turn:<turnId>` key and the same retention horizon, in its
  // own row. Separate rows because the snapshot's content digest drives
  // divergence detection and a replayed turn legitimately re-assembles a
  // different prompt (new datetime anchor, drained completion notices).
  `
  CREATE TABLE IF NOT EXISTS custody_context_manifests (
    generation_context_ref TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    block_count INTEGER NOT NULL,
    sourced_block_count INTEGER NOT NULL,
    source_count INTEGER NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    content_sha256 TEXT NOT NULL,
    manifest_json JSONB NOT NULL,
    CHECK (generation_context_ref = 'turn:' || turn_id),
    CHECK (turn_id ~ '^[A-Za-z0-9_:.@+-]{1,128}$'),
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (block_count >= 0),
    CHECK (sourced_block_count >= 0),
    CHECK (sourced_block_count <= block_count),
    CHECK (source_count >= 0),
    CHECK (recorded_at_ms > 0),
    CHECK (jsonb_typeof(manifest_json) = 'object')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_custody_context_manifests_recorded_at
    ON custody_context_manifests(recorded_at_ms);
  `,
  // ccgdz.7: the query seam asks the reverse question — "which generations
  // admitted THIS source?" — by containment on the snapshot's own source refs
  // (`snapshot_json -> sources -> ref.digest`). `jsonb_path_ops` is the narrow
  // operator class: it indexes only `@>` containment, which is the single
  // operator this seam uses, and is materially smaller than the default class.
  // Without it a source lookup is a sequential scan over the whole retention
  // horizon, which is how a bounded audit read turns into an outage.
  `
  CREATE INDEX IF NOT EXISTS idx_custody_snapshots_sources_gin
    ON custody_snapshots USING GIN (snapshot_json jsonb_path_ops);
  `,
  // Keyset paging for that same lookup orders by `(classified_at_ms, turn_id)`
  // newest-first, so the page cursor is two identifiers the row already carries.
  `
  CREATE INDEX IF NOT EXISTS idx_custody_snapshots_classified_at_turn
    ON custody_snapshots(classified_at_ms DESC, turn_id DESC);
  `,
];

// ── Egress delivery records (psfn-framework-ccgdz.6) ──
//
// Sibling of `custody_snapshots`: the snapshot records which sources were
// admitted into a generation, this records what was then released (or held) on
// the strength of it. Keyed by a composite of identifiers the runtime already
// mints — the lineage's `generationContextRef` plus a digest of the call site's
// own attempt reference — because one turn can release more than once.
//
// The CHECK constraints are the content-free floor: closed vocabularies,
// bounded identifiers, lowercase-hex digests, non-negative counts. A held row
// must state its reason; an unexplained hold cannot reach a column. Retention
// shares the operator-owned `custodySnapshotRetentionDays` horizon, since a
// delivery record and the snapshot it cites must expire together or the
// surviving half becomes an unresolvable claim.
export const POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS egress_delivery_records (
    delivery_ref TEXT PRIMARY KEY,
    generation_context_ref TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_companion_id TEXT,
    surface TEXT NOT NULL,
    disposition TEXT NOT NULL,
    enforcement_posture TEXT NOT NULL,
    attempt_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    destination_kind TEXT,
    outcome TEXT NOT NULL,
    decision_allowed BOOLEAN NOT NULL,
    hold_reason TEXT,
    custody_snapshot_ref TEXT,
    source_count INTEGER NOT NULL,
    has_unclassified_source BOOLEAN NOT NULL,
    effective_sensitivity TEXT NOT NULL,
    recorded_at_ms BIGINT NOT NULL,
    record_sha256 TEXT NOT NULL,
    record_json JSONB NOT NULL,
    CHECK (delivery_ref = generation_context_ref || '#' || attempt_sha256),
    CHECK (generation_context_ref = 'turn:' || turn_id),
    CHECK (turn_id ~ '^[A-Za-z0-9_:.@+-]{1,128}$'),
    CHECK (owner_kind IN ('system', 'companion')),
    CHECK ((owner_kind = 'companion') = (owner_companion_id IS NOT NULL)),
    CHECK (surface IN ('social_reply', 'tool_egress', 'artifact_share')),
    CHECK (disposition IN ('released', 'held')),
    CHECK (enforcement_posture IN ('shadow', 'enforce')),
    CHECK (attempt_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
    CHECK (destination_kind IS NULL OR destination_kind IN (
      'companion_self', 'contact_dm', 'invite_only_room', 'public_room', 'publication'
    )),
    CHECK (outcome IN ('auto_shareable', 'restricted', 'approval_required', 'non_shareable')),
    CHECK (hold_reason IS NULL OR hold_reason IN (
      'custody_snapshot_missing', 'custody_store_unavailable', 'lineage_missing',
      'no_admitted_source', 'unclassified_source'
    )),
    CHECK (disposition <> 'held' OR hold_reason IS NOT NULL),
    CHECK (custody_snapshot_ref IS NULL OR custody_snapshot_ref = generation_context_ref),
    CHECK (source_count >= 0),
    CHECK (effective_sensitivity IN ('public', 'personal', 'intimate', 'confidential')),
    CHECK (recorded_at_ms > 0),
    CHECK (jsonb_typeof(record_json) = 'object')
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_egress_delivery_records_generation
    ON egress_delivery_records(generation_context_ref, recorded_at_ms);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_egress_delivery_records_content
    ON egress_delivery_records(content_sha256);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_egress_delivery_records_recorded_at
    ON egress_delivery_records(recorded_at_ms);
  `,
];
