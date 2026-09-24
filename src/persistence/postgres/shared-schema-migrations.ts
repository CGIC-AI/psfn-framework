// The shared chain (version 21) installs the same health-event and escalation
// DDL a per-companion runtime opens, from one definition.
import {
  POSTGRES_HEALTH_EVENT_MIGRATIONS as RUNTIME_HEALTH_EVENT_TABLE_STATEMENTS,
  POSTGRES_HUMAN_ESCALATION_MIGRATIONS as HUMAN_ESCALATION_TABLE_STATEMENTS,
} from './health-escalation-migrations.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';

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
