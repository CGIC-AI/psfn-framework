import { POSTGRES_CHANNEL_TYPE_VALUES } from './postgres-channel-type-values.js';

export const POSTGRES_INTENTION_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS active_concerns (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    priority TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    salience DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    owner TEXT NOT NULL DEFAULT 'companion',
    evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolution_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    resolved_at TEXT,
    resolution_outcome TEXT,
    contact_id TEXT,
    formation_vad JSONB,
    resolution_vad JSONB,
    resolution_generation_id TEXT,
    last_reviewed_at TEXT,
    next_review_at TEXT,
    merged_from_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    split_from_id TEXT,
    origin_icp_root_initiation_id UUID,
    candidate_review_snapshot JSONB,
    CHECK (priority IN ('high', 'medium', 'low')),
    CHECK (source IN ('appraisal', 'agent', 'heartbeat')),
    CHECK (status IN ('candidate', 'active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed')),
    CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential', 'redacted')),
    CHECK (owner IN ('companion', 'operator', 'system')),
    CHECK (salience >= 0 AND salience <= 1)
  );
  `,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS salience DOUBLE PRECISION NOT NULL DEFAULT 0.5;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'personal';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'companion';`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS resolution_evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS last_reviewed_at TEXT;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS next_review_at TEXT;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS merged_from_ids JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS split_from_id TEXT;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS origin_icp_root_initiation_id UUID;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS candidate_review_snapshot JSONB;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS resolution_vad JSONB;`,
  `ALTER TABLE active_concerns ADD COLUMN IF NOT EXISTS resolution_generation_id TEXT;`,
  `
  UPDATE active_concerns
  SET status = 'resolved'
  WHERE resolved_at IS NOT NULL AND COALESCE(status, 'active') = 'active';
  `,
  `
  UPDATE active_concerns
  SET last_reviewed_at = created_at
  WHERE last_reviewed_at IS NULL;
  `,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_active ON active_concerns (resolved_at, expires_at, priority, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_contact ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_active_concerns_lifecycle ON active_concerns (status, next_review_at, expires_at, last_reviewed_at, id);`,
  `
  CREATE OR REPLACE FUNCTION enforce_active_concern_attention_cap()
  RETURNS TRIGGER AS $$
  DECLARE
    attention_count INTEGER;
    entering_attention BOOLEAN;
  BEGIN
    -- The admission cap gates ONLY transitions INTO active attention: an INSERT
    -- that creates an attention concern, or an UPDATE that moves a concern into
    -- attention status from a resolved/non-attention state. Maintenance updates
    -- of an already-admitted attention concern (last_reviewed_at bumps from
    -- routine review, expires_at extensions, salience changes, etc.) MUST NOT be
    -- re-evaluated against the cap; re-reviewing an admitted concern can never be
    -- blocked by admission pressure. Fail-closed remains intact: a genuine
    -- over-cap admission still raises below.
    IF NEW.resolved_at IS NULL
      AND NEW.status IN ('active', 'watching', 'deferred', 'blocked')
      AND NEW.expires_at::timestamptz > NEW.last_reviewed_at::timestamptz
    THEN
      IF TG_OP = 'INSERT' THEN
        entering_attention := TRUE;
      ELSE
        -- UPDATE: admission only when the prior row was not already an
        -- unresolved attention concern (i.e. it is crossing INTO attention now).
        entering_attention := OLD.resolved_at IS NOT NULL
          OR OLD.status NOT IN ('active', 'watching', 'deferred', 'blocked');
      END IF;

      IF entering_attention THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('active-concern-attention-cap', 0));
        SELECT COUNT(*) INTO attention_count
        FROM active_concerns concern
        WHERE concern.id <> NEW.id
          AND concern.resolved_at IS NULL
          AND concern.status IN ('active', 'watching', 'deferred', 'blocked')
          AND concern.expires_at::timestamptz > NEW.last_reviewed_at::timestamptz
          AND concern.created_at::timestamptz > NEW.last_reviewed_at::timestamptz - INTERVAL '7 days';
        IF attention_count >= 7 THEN
          RAISE EXCEPTION 'Active concern cap reached (7)';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  `,
  `DROP TRIGGER IF EXISTS trg_active_concern_attention_cap ON active_concerns;`,
  `CREATE TRIGGER trg_active_concern_attention_cap
    BEFORE INSERT OR UPDATE OF status, resolved_at
    ON active_concerns
    FOR EACH ROW EXECUTE FUNCTION enforce_active_concern_attention_cap();`,
  `
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
    context_summary TEXT,
    wake_conditions TEXT,
    origin_icp_root_initiation_id UUID,
    activated_at TEXT,
    activation_reason TEXT,
    dampened_at TEXT,
    dampening_reason TEXT,
    CHECK (priority IN ('low', 'medium', 'high')),
    CHECK (timing IN ('immediate', 'soon', 'scheduled')),
    CHECK ((dampened_at IS NULL) = (dampening_reason IS NULL)),
    CHECK (activated_at IS NULL OR dampened_at IS NULL),
    CHECK (channel_type IN (${POSTGRES_CHANNEL_TYPE_VALUES}))
  );
  `,
  `ALTER TABLE intention_pending_follow_ups
    DROP CONSTRAINT IF EXISTS intention_pending_follow_ups_channel_type_check;`,
  `ALTER TABLE intention_pending_follow_ups
    ADD CONSTRAINT intention_pending_follow_ups_channel_type_check
    CHECK (channel_type IN (${POSTGRES_CHANNEL_TYPE_VALUES}));`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS context_summary TEXT;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS wake_conditions TEXT;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS origin_icp_root_initiation_id UUID;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS dampened_at TEXT;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS dampening_reason TEXT;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS formation_vad JSONB;`,
  `ALTER TABLE intention_pending_follow_ups ADD COLUMN IF NOT EXISTS completion_vad JSONB;`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active ON intention_pending_follow_ups (activated_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_live ON intention_pending_follow_ups (activated_at, dampened_at, created_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact ON intention_pending_follow_ups (contact_id, activated_at, created_at, id);`,
  `
  CREATE TABLE IF NOT EXISTS intention_pending_follow_up_quarantine (
    id TEXT PRIMARY KEY,
    follow_up_id TEXT,
    reason TEXT NOT NULL,
    source TEXT,
    raw_entry TEXT NOT NULL,
    quarantined_at TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_up_quarantine_follow_up ON intention_pending_follow_up_quarantine (follow_up_id, quarantined_at, id);`,
  `
  CREATE TABLE IF NOT EXISTS behavioral_pattern_events (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    response_excerpt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    outcome_score DOUBLE PRECISION,
    outcome_observed_at TEXT,
    outcome_source_message_id TEXT,
    promoted_at TEXT,
    promoted_memory_id TEXT,
    UNIQUE(contact_id, source_message_id, strategy)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_events_contact ON behavioral_pattern_events(contact_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_events_outcome ON behavioral_pattern_events(contact_id, outcome_score DESC NULLS LAST, outcome_observed_at DESC NULLS LAST);`,
  // Weighted-thought lifecycle (Charter 6.24, bead 1xb.4). Accumulated weight
  // and lastReinforcedAt persist so decay is deterministic across restart;
  // decay is computed at read time (no in-memory-only accumulator, 9vi.13).
  `
  CREATE TABLE IF NOT EXISTS weighted_thoughts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    thought_class TEXT NOT NULL DEFAULT 'standard',
    contact_id TEXT,
    base_weight DOUBLE PRECISION NOT NULL,
    context_multipliers JSONB NOT NULL DEFAULT '{}'::jsonb,
    accumulated_weight DOUBLE PRECISION NOT NULL,
    reinforcement_count INTEGER NOT NULL DEFAULT 0,
    decay_halflife_ms DOUBLE PRECISION NOT NULL,
    created_at TEXT NOT NULL,
    last_reinforced_at TEXT NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    nudge_state TEXT NOT NULL DEFAULT 'pending',
    last_nudged_at TEXT,
    decline_count INTEGER NOT NULL DEFAULT 0,
    CHECK (thought_class IN ('time_sensitive', 'standard', 'trivial')),
    CHECK (nudge_state IN ('pending', 'nudged', 'accepted', 'declined')),
    CHECK (base_weight >= 0),
    CHECK (accumulated_weight >= 0),
    CHECK (decay_halflife_ms > 0)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_weighted_thoughts_active ON weighted_thoughts(nudge_state, accumulated_weight DESC, last_reinforced_at DESC, id);`,
  `CREATE INDEX IF NOT EXISTS idx_weighted_thoughts_contact ON weighted_thoughts(contact_id, nudge_state, accumulated_weight DESC, id);`,
  // Per-contact durable social desire (epic oth4, bead oth4.1). contact_id is
  // the PRIMARY KEY so the one-desire-per-contact coalescing invariant is
  // schema-enforced. Pressure values persist with their anchor timestamp;
  // decay is computed at read time, so pressure survives restart without a
  // decay writer (9vi.13 pattern). Accumulation is relationship-tier gated
  // upstream — stranger/public tiers never produce a row at all.
  `
  CREATE TABLE IF NOT EXISTS social_desires (
    contact_id TEXT PRIMARY KEY,
    warm_pressure DOUBLE PRECISION NOT NULL DEFAULT 0,
    repair_pressure DOUBLE PRECISION NOT NULL DEFAULT 0,
    pressure_anchor_at TEXT NOT NULL,
    last_warm_felt_at TEXT,
    last_repair_felt_at TEXT,
    last_warm_tick_at TEXT,
    last_repair_tick_at TEXT,
    tick_count INTEGER NOT NULL DEFAULT 0,
    absorbed_signal_count INTEGER NOT NULL DEFAULT 0,
    tier_at_last_tick TEXT NOT NULL,
    reinforced_concern_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TEXT NOT NULL,
    CHECK (warm_pressure >= 0),
    CHECK (repair_pressure >= 0),
    CHECK (tick_count >= 0),
    CHECK (absorbed_signal_count >= 0),
    CHECK (tier_at_last_tick IN ('acquaintance', 'friend', 'family', 'partner', 'ai_companion'))
  );
  `,
  `ALTER TABLE social_desires DROP CONSTRAINT IF EXISTS social_desires_tier_at_last_tick_check;`,
  `
  ALTER TABLE social_desires
    ADD CONSTRAINT social_desires_tier_at_last_tick_check
    CHECK (tier_at_last_tick IN ('acquaintance', 'friend', 'family', 'partner', 'ai_companion'));
  `,
  `
  CREATE TABLE IF NOT EXISTS social_desire_settlements (
    settlement_id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('sent', 'terminal_block')),
    settled_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE social_desire_settlements
    DROP CONSTRAINT IF EXISTS social_desire_settlements_contact_id_fkey;
  `,
  // Per-contact outreach pacing (psfn-framework-vcq8v.4): the cooldown anchor
  // and the companion's "later" re-evaluation time for each contact's desire.
  `ALTER TABLE social_desires ADD COLUMN IF NOT EXISTS last_consent_moment_at TEXT;`,
  `ALTER TABLE social_desires ADD COLUMN IF NOT EXISTS deferred_until TEXT;`,
  // Companion-local ICP candidate state. The reason summary and peer contact
  // binding are private motivation, so this table belongs in each companion's
  // own schema and must never be copied into the shared control-plane tables.
  `
  CREATE TABLE IF NOT EXISTS icp_initiation_candidates (
    candidate_id UUID PRIMARY KEY,
    root_initiation_id UUID NOT NULL,
    local_companion_id UUID NOT NULL,
    peer_contact_id TEXT NOT NULL,
    peer_companion_id UUID NOT NULL,
    preferred_channel TEXT NOT NULL CHECK (preferred_channel IN ('dm', 'current_room')),
    target_channel_id TEXT,
    source TEXT NOT NULL CHECK (source IN (
      'free_time', 'weighted_thought', 'intention', 'foreground', 'felt_impulse'
    )),
    provenance_ref TEXT NOT NULL,
    reason_summary TEXT NOT NULL,
    continuation_task_kind TEXT CHECK (
      continuation_task_kind IS NULL
      OR continuation_task_kind IN ('work', 'research', 'problem_solving')
    ),
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'deferred', 'declined', 'rejected', 'permitted',
      'consumed', 'expired', 'cancelled'
    )),
    reason_code TEXT,
    initiation_permit_id UUID,
    pending_follow_up_id TEXT,
    delivery_disposition TEXT CHECK (delivery_disposition IN ('delivered', 'suppressed')),
    retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
    retry_eligible_at_ms BIGINT,
    lifecycle_claim_token UUID,
    lifecycle_claim_expires_at_ms BIGINT,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    CHECK (local_companion_id <> peer_companion_id),
    CHECK (pending_follow_up_id IS NULL OR source = 'intention'),
    CHECK (delivery_disposition IS NULL OR status = 'consumed')
  );
  `,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS continuation_task_kind TEXT
    CHECK (
      continuation_task_kind IS NULL
      OR continuation_task_kind IN ('work', 'research', 'problem_solving')
    );`,
  `CREATE INDEX IF NOT EXISTS idx_icp_initiation_candidates_status
    ON icp_initiation_candidates (status, expires_at_ms, created_at_ms, candidate_id);`,
  `CREATE INDEX IF NOT EXISTS idx_icp_initiation_candidates_peer
    ON icp_initiation_candidates (peer_companion_id, status, created_at_ms, candidate_id);`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS initiation_permit_id UUID;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS pending_follow_up_id TEXT;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS delivery_disposition TEXT;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS retry_attempt INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS retry_eligible_at_ms BIGINT;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS target_channel_id TEXT;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS lifecycle_claim_token UUID;`,
  `ALTER TABLE icp_initiation_candidates
    ADD COLUMN IF NOT EXISTS lifecycle_claim_expires_at_ms BIGINT;`,
  `CREATE INDEX IF NOT EXISTS idx_icp_initiation_candidates_lifecycle_due
    ON icp_initiation_candidates (
      status, retry_eligible_at_ms, expires_at_ms, lifecycle_claim_expires_at_ms, candidate_id
    )
    WHERE status IN ('pending', 'deferred', 'permitted');`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_initiation_candidates_pending_follow_up
    ON icp_initiation_candidates (pending_follow_up_id)
    WHERE pending_follow_up_id IS NOT NULL;`,
  // hrmrq.34 (operator ruling D4): affect-driven initiation source
  // 'felt_impulse' — the emo-sim would_message lever creating the candidate.
  `ALTER TABLE icp_initiation_candidates
    DROP CONSTRAINT IF EXISTS icp_initiation_candidates_source_check;`,
  `ALTER TABLE icp_initiation_candidates
    ADD CONSTRAINT icp_initiation_candidates_source_check
    CHECK (source IN (
      'free_time', 'weighted_thought', 'intention', 'foreground', 'felt_impulse', 'operator_test'
    ));`,
  // Content-free exactly-once provenance for every qualified felt-impulse
  // fire. Candidate lifecycle stays canonical in icp_initiation_candidates;
  // this table stores only the immutable fire disposition or candidate link.
  `
  CREATE TABLE IF NOT EXISTS icp_felt_impulse_funnel_outcomes (
    correlation_id TEXT PRIMARY KEY,
    first_crossing_ms BIGINT NOT NULL CHECK (first_crossing_ms >= 0),
    fired_at_ms BIGINT NOT NULL CHECK (fired_at_ms >= 0),
    recorded_at_ms BIGINT NOT NULL CHECK (recorded_at_ms >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN (
      'no_eligible_peer', 'not_authorized', 'throttled', 'candidate_linked'
    )),
    next_eligible_at_ms BIGINT,
    candidate_id UUID REFERENCES icp_initiation_candidates(candidate_id) ON DELETE RESTRICT,
    candidate_outcome TEXT CHECK (candidate_outcome IN ('submitted', 'deduped')),
    CHECK (
      correlation_id ~ '^felt-impulse:would_message:[0-9]+$'
      AND char_length(correlation_id) <= char_length('felt-impulse:would_message:')
        + char_length('9007199254740991')
      AND substring(
        correlation_id FROM char_length('felt-impulse:would_message:') + 1
      ) = first_crossing_ms::TEXT
      AND fired_at_ms >= first_crossing_ms
    ),
    CHECK (
      (outcome = 'throttled') = (next_eligible_at_ms IS NOT NULL)
      AND (next_eligible_at_ms IS NULL OR next_eligible_at_ms > recorded_at_ms)
    ),
    CHECK (
      (outcome = 'candidate_linked')
      = (candidate_id IS NOT NULL AND candidate_outcome IS NOT NULL)
    )
  );
  `,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_icp_felt_impulse_funnel_candidate
    ON icp_felt_impulse_funnel_outcomes (candidate_id)
    WHERE candidate_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_icp_felt_impulse_funnel_recent
    ON icp_felt_impulse_funnel_outcomes (fired_at_ms DESC, correlation_id);`,
  `
  CREATE TABLE IF NOT EXISTS emosim_proactivity_state (
    source_kind TEXT PRIMARY KEY CHECK (source_kind = 'would_message'),
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    first_crossing_ms BIGINT CHECK (first_crossing_ms >= 0),
    last_fired_at_ms BIGINT CHECK (last_fired_at_ms >= 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0)
  );
  `,
  `ALTER TABLE emosim_proactivity_state
    ADD COLUMN IF NOT EXISTS last_sampled_at_ms BIGINT CHECK (last_sampled_at_ms >= 0);`,
  `ALTER TABLE emosim_proactivity_state
    ADD COLUMN IF NOT EXISTS last_input_id TEXT CHECK (last_input_id IS NULL OR length(btrim(last_input_id)) > 0);`,
  // Companion-local, content-free disposition ledger for qualified social
  // impulses. Local intent text is never persisted; binding_hash fences the
  // exact choice/target/intent tuple. Durable dyad identity is valid only for
  // an established companion DM. Human, first-contact, and room destinations
  // deliberately keep dyad_id NULL.
  `
  CREATE TABLE IF NOT EXISTS social_impulse_outreach_opportunities (
    opportunity_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    companion_id UUID NOT NULL,
    impulse_dedupe_key TEXT NOT NULL,
    first_crossing_ms BIGINT NOT NULL CHECK (first_crossing_ms >= 0),
    fired_at_ms BIGINT NOT NULL CHECK (fired_at_ms >= first_crossing_ms),
    mode_at_creation TEXT NOT NULL CHECK (mode_at_creation IN ('off', 'shadow', 'on')),
    state TEXT NOT NULL CHECK (state IN (
      'pending', 'chosen', 'off', 'ignore', 'defer', 'other',
      'would_send', 'delivered', 'suppressed'
    )),
    disposition TEXT CHECK (disposition IN (
      'ignore', 'defer', 'contact-human', 'contact-companion', 'join-room', 'other'
    )),
    destination_kind TEXT CHECK (destination_kind IN (
      'human_dm', 'open_companion_dyad', 'companion_first_contact', 'room'
    )),
    destination_id TEXT,
    contact_id TEXT,
    display_label TEXT,
    channel_id TEXT,
    channel_type TEXT,
    dyad_id UUID,
    binding_hash TEXT CHECK (binding_hash IS NULL OR binding_hash ~ '^[0-9a-f]{64}$'),
    reason_code TEXT,
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (
      opportunity_id = impulse_dedupe_key
      AND opportunity_id ~ '^felt-impulse:would_message:[0-9]+$'
      AND substring(
        opportunity_id FROM char_length('felt-impulse:would_message:') + 1
      ) = first_crossing_ms::TEXT
    ),
    CHECK ((state IN ('pending', 'off')) = (binding_hash IS NULL)),
    CHECK ((binding_hash IS NULL) = (disposition IS NULL)),
    CHECK ((destination_kind IS NULL) = (destination_id IS NULL)),
    CHECK (
      (destination_kind = 'open_companion_dyad'
        AND dyad_id IS NOT NULL AND channel_type = 'companion'
        AND channel_id ~ '^companion-dm:[0-9a-f-]+:[0-9a-f-]+$')
      OR (destination_kind IS DISTINCT FROM 'open_companion_dyad' AND dyad_id IS NULL)
    ),
    CHECK (destination_kind IS DISTINCT FROM 'room' OR channel_type IN ('discord', 'buzz')),
    CHECK (destination_kind IS DISTINCT FROM 'human_dm' OR channel_type = 'discord'),
    CHECK (destination_kind IS DISTINCT FROM 'companion_first_contact' OR channel_id IS NULL)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_social_impulse_outreach_state
    ON social_impulse_outreach_opportunities (state, fired_at_ms DESC, opportunity_id);`,
  // A queued choice has not crossed any delivery boundary. Its private intent
  // survives a crash before queue admission; terminal settlement clears it.
  `ALTER TABLE social_impulse_outreach_opportunities
    ADD COLUMN IF NOT EXISTS execution_intent TEXT;`,
  `ALTER TABLE social_impulse_outreach_opportunities
    ADD COLUMN IF NOT EXISTS origin_icp_root_initiation_id UUID;`,
  `ALTER TABLE social_impulse_outreach_opportunities
    DROP CONSTRAINT IF EXISTS social_impulse_outreach_opportunities_state_check;`,
  `ALTER TABLE social_impulse_outreach_opportunities
    ADD CONSTRAINT social_impulse_outreach_opportunities_state_check CHECK (state IN (
      'pending', 'queued', 'chosen', 'off', 'ignore', 'defer', 'other',
      'would_send', 'delivered', 'suppressed'
    ));`,
  `CREATE INDEX IF NOT EXISTS idx_social_outreach_destination_active
    ON social_impulse_outreach_opportunities (companion_id, destination_id, updated_at_ms DESC, opportunity_id DESC)
    WHERE state IN ('pending', 'queued', 'chosen');`,
  `CREATE INDEX IF NOT EXISTS idx_social_outreach_destination_terminal
    ON social_impulse_outreach_opportunities (companion_id, destination_id, updated_at_ms DESC, opportunity_id DESC)
    WHERE state NOT IN ('pending', 'queued', 'chosen');`,
  // psfn-framework-vcq8v.4: an EmoSim impulse no longer opens its own
  // destination disposition (the opportunities table above is retired and no
  // longer written). It raises per-contact social pressure; this content-free
  // ledger records each impulse exactly once so a replay never boosts twice.
  `
  CREATE TABLE IF NOT EXISTS social_impulse_outreach_ledger (
    impulse_id TEXT PRIMARY KEY
      CHECK (impulse_id ~ '^felt-impulse:would_message:[0-9]+$'),
    companion_id UUID NOT NULL,
    first_crossing_ms BIGINT NOT NULL CHECK (first_crossing_ms >= 0),
    fired_at_ms BIGINT NOT NULL CHECK (fired_at_ms >= first_crossing_ms),
    confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    mode_at_receipt TEXT NOT NULL CHECK (mode_at_receipt IN ('off', 'shadow', 'on')),
    state TEXT NOT NULL CHECK (state IN (
      'received', 'off', 'shadow', 'applied', 'no_live_desire', 'lane_disabled', 'interrupted'
    )),
    boosted_contact_count INTEGER NOT NULL DEFAULT 0 CHECK (boosted_contact_count >= 0),
    reason_code TEXT,
    created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= created_at_ms)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_social_impulse_outreach_ledger_companion
    ON social_impulse_outreach_ledger (companion_id, fired_at_ms DESC);`,
];
