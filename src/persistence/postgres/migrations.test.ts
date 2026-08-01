import { describe, expect, it } from 'vitest';

import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_BACKGROUND_WORK_MIGRATIONS,
  POSTGRES_ENROLLMENT_MIGRATIONS,
  POSTGRES_INTENTION_MIGRATIONS,
  POSTGRES_INTROSPECTION_MIGRATIONS,
  POSTGRES_MEMORY_MIGRATIONS,
  POSTGRES_MODEL_USAGE_MIGRATIONS,
  POSTGRES_SHARED_ALL_MIGRATION_VERSIONS,
  POSTGRES_SHARED_MIGRATIONS,
  POSTGRES_SHARED_WIKI_MIGRATIONS,
  POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS,
  POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS,
} from './migrations.js';
import { MODEL_USAGE_RUNTIME_LANE_CLASSES } from '../../shared/telemetry/model-usage-attribution.js';
import { RUNTIME_LANE_CLASSES } from '../../shared/contracts/runtime-lanes.js';

function migrationSql(statements: readonly string[]): string {
  return statements.join('\n');
}

function expectAddColumn(sql: string, table: string, column: string): void {
  expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
}

describe('Postgres live schema migrations', () => {
  it('keeps the combined shared-schema ledger unique and sequential across both chains', () => {
    const registeredVersions = [
      ...POSTGRES_SHARED_MIGRATIONS,
      ...POSTGRES_SHARED_WIKI_MIGRATIONS,
    ]
      .flatMap(statement => {
        const match = /INSERT INTO shared_schema_migrations[\s\S]*?VALUES \((\d+),/.exec(statement);
        return match?.[1] === undefined ? [] : [Number(match[1])];
      })
      .sort((left, right) => left - right);

    expect(registeredVersions).toEqual([...POSTGRES_SHARED_ALL_MIGRATION_VERSIONS]);
    expect(registeredVersions).toEqual(
      Array.from({ length: registeredVersions.length }, (_, index) => index + 1),
    );
  });

  it('retains social-desire settlement identities across desire deletion and recreation', () => {
    const sql = migrationSql(POSTGRES_INTENTION_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_desire_settlements');
    expect(sql).not.toContain(
      'contact_id TEXT NOT NULL REFERENCES social_desires(contact_id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS social_desire_settlements_contact_id_fkey',
    );
  });

  it('creates a companion-private leased background-work queue with fail-closed states', () => {
    const sql = migrationSql(POSTGRES_BACKGROUND_WORK_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_background_work_jobs');
    expect(sql).toContain('idempotency_key TEXT NOT NULL UNIQUE');
    expect(sql).toContain('payload_fingerprint TEXT NOT NULL');
    expect(sql).toContain("'emotion_appraisal'");
    expect(sql).toContain("'stale_discarded'");
    expect(sql).toContain("'effect_outcome_unknown'");
    expect(sql).toContain('deferred_from_available_at_ms BIGINT');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_background_work_foreground_leases');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_background_work_handoffs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_background_work_effect_receipts');
    expect(sql).toContain("state = 'running' AND lease_owner IS NOT NULL");
    expect(sql).toContain("state <> 'running' AND lease_owner IS NULL");
    expect(sql).toContain('idx_agent_background_work_one_running_per_session');
    expect(sql).toContain("WHERE state = 'running'");
    expect(sql).toContain('idx_agent_background_work_runnable');
    expect(sql).toContain('idx_agent_background_work_terminal_retention');
    expect(sql).toContain("WHERE state IN ('succeeded', 'failed', 'stale_discarded')");
  });

  it('creates append-only introspection landmark and audit-decision ledgers', () => {
    const sql = migrationSql(POSTGRES_INTROSPECTION_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS introspection_landmarks');
    expect(sql).toContain('UNIQUE (id, source_ref)');
    expect(sql).toContain("CHECK (divergence_type IN ('affective', 'substantive'))");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS introspection_audit_decisions');
    expect(sql).toContain('source_ref TEXT PRIMARY KEY');
    expect(sql).toContain("CHECK (outcome IN ('no_divergence', 'below_confidence', 'landmark_created'))");
    expect(sql).toContain('FOREIGN KEY (landmark_id, source_ref)');
    expect(sql).toContain('REFERENCES introspection_landmarks(id, source_ref)');
    expect(sql).toContain("CHECK (provenance_json <> '{}'::jsonb)");
    expect(sql).toContain('CHECK (octet_length(provenance_json::text) <= 65536)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_introspection_ledger_mutation()');
    expect(sql).toContain("IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE')");
    expect(sql).toContain('CREATE TRIGGER introspection_landmarks_append_only');
    expect(sql).toContain('CREATE TRIGGER introspection_landmarks_no_truncate');
    expect(sql).toContain('CREATE TRIGGER introspection_audit_decisions_append_only');
    expect(sql).toContain('CREATE TRIGGER introspection_audit_decisions_no_truncate');
  });

  it('upgrades existing l2 memory tables with scoped memory columns before indexed use', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    for (const column of [
      'formation_vad',
      'scope_ref_kind',
      'scope_ref_id',
      'scope_ref_label',
      'scope_tags',
      'provenance_refs',
      'retention_class',
      'sensitivity',
      'consent_flags',
      'contact_id',
      'deleted_at',
      'deleted_by',
      'delete_reason',
    ]) {
      expectAddColumn(sql, 'l2_memories', column);
    }

    expect(sql.indexOf('ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS scope_ref_kind')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_l2_memories_scope_ref'),
    );
    expect(sql.indexOf('ALTER TABLE l2_memories ADD COLUMN IF NOT EXISTS contact_id')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_l2_memories_contact'),
    );
    expect(sql).toContain("scope_tags JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(sql).toContain("sensitivity TEXT NOT NULL DEFAULT 'personal'");
    expect(sql).toContain("consent_flags JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it('creates the episode message-claim table with a one-live-claim-per-message unique index', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS l01_episode_message_claims');
    expect(sql).toContain('PRIMARY KEY (episode_id, claim_key)');
    expect(sql).toContain("CHECK (status IN ('active', 'transferred'))");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_episode_message_claims_active_key '
      + "ON l01_episode_message_claims(claim_key) WHERE status = 'active';",
    );
    // Claims reference episodes, so the episode table must be created first.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS l01_episodes')).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS l01_episode_message_claims'),
    );
  });

  it('records episode first-person authorship without guessing legacy rows', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    expectAddColumn(sql, 'l01_episodes', 'affect_authorship');
    expectAddColumn(sql, 'l01_episodes', 'meaning_authorship');
    expect(sql).toContain('l01_episodes_affect_authorship_check');
    expect(sql).toContain('l01_episodes_meaning_authorship_check');
    expect(sql).toContain("affect_authorship IN ('none', 'companion', 'companion_preserved')");
    expect(sql).toContain("meaning_authorship IN ('none', 'companion', 'companion_preserved')");
    expect(sql).not.toContain('UPDATE l01_episodes SET affect_authorship');
    expect(sql).not.toContain('UPDATE l01_episodes SET meaning_authorship');
  });

  it('upgrades existing contact tables and creates social graph tables for companion DBs', () => {
    const sql = migrationSql(POSTGRES_CONTACT_MIGRATIONS);

    for (const column of [
      'nickname',
      'notes',
      'timezone',
      'channel_identities',
      'conversation_channels',
      'emotional_time_series',
      'is_machine_intelligence',
      'trust_version',
      'contact_authority_version',
      'contact_lifecycle_state',
      'contact_restore_state',
    ]) {
      expectAddColumn(sql, 'contacts', column);
    }

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_graph_entities');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS social_relationship_edges');
    expect(sql).toContain('contact_id TEXT UNIQUE');
    expect(sql).toContain('evidence_memory_ids JSONB NOT NULL DEFAULT');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS contact_lifecycle_intents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS contact_lifecycle_target_locks');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS contact_lifecycle_results');
    expect(sql).toContain('identity_version BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain("ownership_state IN ('unverified', 'verified', 'deleted', 'quarantined')");
    expect(sql).toContain('verification_digest');
    expect(sql).toContain('idx_contact_lifecycle_active_target');
    expect(sql).toContain('committed_contact_version BIGINT');
    expect(sql).toContain("NEW.phase = 'gateway_finalize_pending'");
  });

  it('extends the shared chain with companion_presence as versioned migration 2 (W5a)', () => {
    const sql = migrationSql(POSTGRES_SHARED_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS companion_presence');
    expect(sql).toContain('companion_id UUID PRIMARY KEY');
    expect(sql).toContain("CHECK (kind IN ('physical', 'virtual'))");
    expect(sql).toContain('since TIMESTAMPTZ NOT NULL DEFAULT now()');
    expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    // Co-presence read path is always keyed by (site_id, place_id).
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_companion_presence_place');
    expect(sql).toContain('ON companion_presence (site_id, place_id)');

    // The versioned ledger chain stays intact: ledger first, then baseline,
    // then the presence version.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS shared_schema_migrations')).toBeLessThan(
      sql.indexOf("VALUES (1, 'shared-schema-baseline')"),
    );
    expect(sql.indexOf("VALUES (1, 'shared-schema-baseline')")).toBeLessThan(
      sql.indexOf('CREATE TABLE IF NOT EXISTS companion_presence'),
    );
    expect(sql).toContain("VALUES (2, 'companion-presence')");
  });

  it('adds restart-durable ICP autonomy state without sharing private candidate text', () => {
    const sharedSql = migrationSql(POSTGRES_SHARED_MIGRATIONS);
    const localSql = migrationSql(POSTGRES_INTENTION_MIGRATIONS);

    for (const table of [
      'icp_autonomy_invalidation_fences',
      'icp_availability_leases',
      'icp_conversation_episodes',
      'icp_initiation_permits',
      'icp_fatigue_turn_reservations',
      'companion_social_pot',
    ]) {
      expect(sharedSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sharedSql).toContain("VALUES (4, 'icp-autonomy-control-plane')");
    expect(sharedSql).toContain("VALUES (5, 'icp-autonomy-invalidation-fences')");
    expect(sharedSql).toContain("VALUES (6, 'icp-fatigue-turn-reservations')");
    expect(sharedSql).toContain("VALUES (7, 'icp-fatigue-delivery-fence')");
    expect(sharedSql).toContain("VALUES (9, 'companion-social-pot')");
    expect(sharedSql).toContain("'delivering'");
    expect(sharedSql).toContain('participant_companion_ids UUID[] NOT NULL');
    expect(sharedSql).toContain('UNIQUE (candidate_id)');
    expect(sharedSql).toContain('idx_icp_initiation_permits_outstanding_pair');
    expect(sharedSql).toContain("WHERE status = 'issued'");
    expect(sharedSql).not.toContain('reason_summary');
    expect(sharedSql).not.toContain('continuation_task_kind');

    expect(localSql).toContain('CREATE TABLE IF NOT EXISTS icp_initiation_candidates');
    expect(localSql).toContain('reason_summary TEXT NOT NULL');
    expect(localSql).toContain('continuation_task_kind TEXT');
    expect(localSql).toContain('peer_contact_id TEXT NOT NULL');
  });

  it('adds the gateway speaking-arbiter state as shared migration 10 (jp36.5.1.1)', () => {
    const sharedSql = migrationSql(POSTGRES_SHARED_MIGRATIONS);

    for (const table of [
      'speaking_room_episodes',
      'speaking_episode_participation',
      'speaking_reservations',
      'speaking_egress_leases',
    ]) {
      expect(sharedSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    // At most one OPEN room episode per channel: the arbitration context.
    expect(sharedSql).toContain(
      'idx_speaking_room_episodes_open_channel',
    );
    // The exclusivity fence: at most one HELD egress lease per triggering event —
    // two companions never both send for one trigger (bible §20.1).
    expect(sharedSql).toContain('idx_speaking_egress_leases_one_held');
    expect(sharedSql).toContain("ON speaking_egress_leases (channel_id, trigger_event_id) WHERE status = 'held'");
    // Dedup: one reservation per (channel, source event, companion) (bible §8.1).
    expect(sharedSql).toContain('UNIQUE (channel_id, trigger_event_id, companion_id)');
    // The monotonic fencing token that stops a revived crashed holder double-sending.
    expect(sharedSql).toContain('UNIQUE (channel_id, trigger_event_id, fencing_token)');
    expect(sharedSql).toContain('fencing_token BIGINT NOT NULL CHECK (fencing_token >= 1)');
    // Content-free: no message text ever lands in the shared arbiter state.
    expect(sharedSql).not.toContain('message_text');
    // Ledger discipline: tables before the version registration, then version 10.
    expect(sharedSql.indexOf('CREATE TABLE IF NOT EXISTS speaking_room_episodes')).toBeLessThan(
      sharedSql.indexOf("VALUES (10, 'speaking-arbiter')"),
    );
    expect(sharedSql).toContain("VALUES (10, 'speaking-arbiter')");

    // The base shared chain stays pgvector-free (the arbiter needs no vectors).
    expect(sharedSql).not.toMatch(/vector/i);
  });

  it('binds the funding charge to the egress lease as shared migration 11 (jp36.5.3)', () => {
    const sharedSql = migrationSql(POSTGRES_SHARED_MIGRATIONS);

    // The crash-recovery charge column: the fatigue draw is recorded on the
    // fenced, correlation-keyed lease so a crash between draw and delivery leaves
    // the debit reconcilable off the lease instead of leaked.
    expect(sharedSql).toContain(
      'ADD COLUMN IF NOT EXISTS charged_units DOUBLE PRECISION NOT NULL DEFAULT 0',
    );
    expect(sharedSql).toContain('CHECK (charged_units >= 0)');
    // Idempotent constraint (re)creation, mirroring the breaker-state migration.
    expect(sharedSql).toContain(
      'DROP CONSTRAINT IF EXISTS speaking_egress_leases_charged_units_check',
    );
    // Ledger discipline: the column alter precedes its version registration.
    expect(sharedSql.indexOf('ADD COLUMN IF NOT EXISTS charged_units')).toBeLessThan(
      sharedSql.indexOf("VALUES (11, 'speaking-arbiter-charge-association')"),
    );
    // It extends the existing lease table — no parallel fencing state.
    expect(sharedSql).toContain('ALTER TABLE speaking_egress_leases');
  });

  it('extends the shared ledger with shared_wiki_chunks as versioned migration 3 (s10f9)', () => {
    const sql = migrationSql(POSTGRES_SHARED_WIKI_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS shared_wiki_chunks');
    // Document ids repeat across sites (`site-overview`), so the key is
    // site-qualified — never (document_id, chunk_index) alone.
    expect(sql).toContain('PRIMARY KEY (site_id, document_id, chunk_index)');
    // Shape mirrors the per-companion wiki_document_chunks table (+ site_id)
    // so chunk query code stays uniform across both projections.
    for (const column of [
      'site_id TEXT NOT NULL',
      'document_id TEXT NOT NULL',
      'chunk_index INTEGER NOT NULL',
      'body_sha256 TEXT NOT NULL',
      'title TEXT NOT NULL',
      'body_path TEXT NOT NULL',
      'source_class TEXT NOT NULL',
      "sensitivity TEXT NOT NULL DEFAULT 'personal'",
      'scope TEXT NOT NULL',
      'chunk_text TEXT NOT NULL',
      'chunk_char_count INTEGER NOT NULL',
      'embedding VECTOR NOT NULL',
      'updated_at BIGINT NOT NULL',
    ]) {
      expect(sql).toContain(column);
    }
    // The DB itself refuses a personal-scoped (or cross-site mis-scoped) row:
    // scope is derived from site_id, closing the W5b leak surface in-schema.
    expect(sql).toContain("CHECK (scope = 'shared_world:' || site_id)");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_shared_wiki_chunks_site ON shared_wiki_chunks(site_id)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_shared_wiki_chunks_scope ON shared_wiki_chunks(scope)');
    // Installed pgvector placement is authoritative across public and named
    // tenant search paths; unavailable pgvector names both accepted schemas.
    expect(sql).toContain("installed_schema NOT IN ('public', 'extensions')");
    expect(sql).toContain("'extensions' = ANY (current_schemas(false))");
    expect(sql).toContain('requires_extension_schema AND installed_schema = \'public\'');
    expect(sql).toContain('public or extensions');
    expect(sql).toContain("CREATE EXTENSION vector WITH SCHEMA %I");
    expect(sql).toContain('tenant migrations require extensions');
    // Ledger discipline: table before its version registration.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS shared_wiki_chunks')).toBeLessThan(
      sql.indexOf("VALUES (3, 'shared-wiki-chunks')"),
    );
    expect(sql).toContain("VALUES (3, 'shared-wiki-chunks')");

    // The wiki chain is deliberately SEPARATE from the base shared chain: the
    // base chain must stay runnable on plain Postgres (no pgvector) for
    // pgvector-free shared consumers like companion_presence.
    const baseSql = migrationSql(POSTGRES_SHARED_MIGRATIONS);
    expect(baseSql).not.toMatch(/vector/i);
    expect(baseSql).not.toContain('shared_wiki_chunks');
  });

  it('adds the durable shared-world caretaker proposal state machine as shared migration 8', () => {
    const sql = migrationSql(POSTGRES_SHARED_WIKI_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS shared_wiki_proposals');
    expect(sql).toContain('UNIQUE (site_id, content_digest)');
    expect(sql).toContain("CHECK (review_state IN ('pending', 'approved', 'rejected'))");
    expect(sql).toContain("CHECK (apply_state IN ('unreviewed', 'ready', 'applying', 'retryable', 'applied', 'rejected'))");
    expect(sql).toContain("CHECK (sensitivity = 'public')");
    expect(sql).toContain('apply_lease_token UUID');
    expect(sql).toContain('projection_body_sha256 TEXT');
    expect(sql).toContain('idx_shared_wiki_proposals_review');
    expect(sql).toContain('idx_shared_wiki_proposals_apply');
    expect(sql).toContain('idx_shared_wiki_proposals_cleanup');
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS shared_wiki_proposals')).toBeLessThan(
      sql.indexOf("VALUES (8, 'shared-wiki-caretaker-proposals')"),
    );
  });

  it('creates the hub-identity enrollment binding + audit tables bound to contacts', () => {
    const sql = migrationSql(POSTGRES_ENROLLMENT_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hub_identity_enrollments');
    expect(sql).toContain('hub_identity_id TEXT PRIMARY KEY');
    expect(sql).toContain('contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hub_identity_enrollment_audit');

    for (const column of ['satellite_id', 'endpoint_id']) {
      expectAddColumn(sql, 'hub_identity_enrollments', column);
    }

    // The binding table must exist before its indexes are created.
    expect(sql.indexOf('CREATE TABLE IF NOT EXISTS hub_identity_enrollments')).toBeLessThan(
      sql.indexOf('CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_contact'),
    );

    // No biometric/template column is ever declared — core stores only the handle.
    expect(sql).not.toMatch(/biometric|embedding|template|face_vector/i);
  });

  // mmo9.7.3 / d8vq.3: the runtime_lane_class CHECK enumerates lane values as a
  // literal SQL list, independent of the RUNTIME_LANE_CLASSES source of truth. This
  // static drift guard fails fast (no Postgres required) if a lane class is added to
  // worker-lanes.ts without extending the shipped CHECK, before the runtime insert
  // would otherwise fail closed against the constraint.
  it('keeps the model_usage_events runtime_lane_class CHECK in sync with the lane-class source of truth', () => {
    const sql = migrationSql(POSTGRES_MODEL_USAGE_MIGRATIONS);

    const checkMatch = sql.match(
      /CONSTRAINT model_usage_events_runtime_lane_class_check\s+CHECK \(runtime_lane_class IN \(([^)]*)\)\)/,
    );
    expect(checkMatch, 'runtime_lane_class CHECK constraint must exist in the model usage migrations')
      .not.toBeNull();

    const checkValues = new Set(
      (checkMatch?.[1] ?? '')
        .split(',')
        .map(value => value.trim().replace(/^'(.*)'$/, '$1'))
        .filter(value => value.length > 0),
    );

    // Every declared runtime lane class (and the 'unknown' sentinel) must be accepted
    // by the CHECK. MODEL_USAGE_RUNTIME_LANE_CLASSES = RUNTIME_LANE_CLASSES + 'unknown'.
    for (const laneClass of MODEL_USAGE_RUNTIME_LANE_CLASSES) {
      expect(
        checkValues.has(laneClass),
        `runtime_lane_class CHECK is missing lane class '${laneClass}'. `
          + 'Add it to the model_usage_events_runtime_lane_class_check list via an additive migration '
          + 'when extending RUNTIME_LANE_CLASSES.',
      ).toBe(true);
    }

    // The CHECK must not silently drift the other way either: every enumerated value is
    // a known lane class or the 'unknown' sentinel.
    const knownValues = new Set<string>(MODEL_USAGE_RUNTIME_LANE_CLASSES);
    for (const checkValue of checkValues) {
      expect(
        knownValues.has(checkValue),
        `runtime_lane_class CHECK enumerates unknown value '${checkValue}'.`,
      ).toBe(true);
    }

    // Sanity: the source-of-truth lane classes are present so the guard is non-vacuous.
    expect(Object.values(RUNTIME_LANE_CLASSES).length).toBeGreaterThan(0);
    for (const laneClass of Object.values(RUNTIME_LANE_CLASSES)) {
      expect(checkValues.has(laneClass)).toBe(true);
    }
  });

  it('keeps the canonical model-usage schema compatible with the pre-attribution rollback writer', () => {
    const sql = migrationSql(POSTGRES_MODEL_USAGE_MIGRATIONS);

    expect(sql).toContain('CREATE OR REPLACE FUNCTION psfn_model_usage_legacy_insert_bridge()');
    expect(sql).toContain("IF NULLIF(BTRIM(NEW.event_fingerprint), '') IS NULL THEN");
    expect(sql).toContain(
      "NEW.turn_id := COALESCE(NULLIF(BTRIM(NEW.turn_id), ''), 'unknown')",
    );
    expect(sql).toContain(
      "NEW.tool_name := COALESCE(NULLIF(BTRIM(NEW.tool_name), ''), 'unknown')",
    );
    expect(sql).toContain(
      "'legacy:rollback-writer:' || NEW.id",
    );
    expect(sql).toContain('CREATE TRIGGER psfn_model_usage_legacy_insert_bridge');
    expect(sql).toContain('BEFORE INSERT ON model_usage_events');
  });
});

describe('Partner affect shadow migrations (docs/partner-affect.md slice 1)', () => {
  it('creates the shadow observation table with the (source_id, observation_id) idempotency key', () => {
    const sql = migrationSql(POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS partner_affect_shadow_observations');
    expect(sql).toContain('UNIQUE (source_id, observation_id)');
    // Provenance is bounded jsonb handles only — never raw source content.
    expect(sql).toContain("CHECK (jsonb_typeof(provenance_json) = 'array')");
    expect(sql).toContain('octet_length(provenance_json::text) <= 16384');
    // Quality fields are range-checked in the schema itself (fail closed).
    expect(sql).toContain('CHECK (coverage >= 0 AND coverage <= 1)');
    expect(sql).toContain('CHECK (confidence >= 0 AND confidence <= 1)');
    expect(sql).toContain('CHECK (missingness >= 0 AND missingness <= 1)');
    expect(sql).toContain("CHECK (direction IN ('higher_supports_need', 'lower_supports_need', 'unknown'))");
    expect(sql).toContain("CHECK (assertion IN ('partner_asserted', 'model_inferred', 'sensor_summary', 'unverified'))");
    expect(sql).toContain('idx_partner_affect_shadow_obs_partner_observed');
  });

  it('creates the structural suppression audit table without content columns and scoped to a partner', () => {
    const sql = migrationSql(POSTGRES_PARTNER_AFFECT_SHADOW_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS partner_affect_shadow_suppressions');
    expect(sql).toContain("CHECK (jsonb_typeof(reasons_json) = 'array')");
    expect(sql).toContain('octet_length(detail) <= 4096');
    // Suppression rows carry the bound partner so the audit can be scoped and
    // survives a re-bind without leaking a prior partner's rows.
    expect(sql).toContain('partner_contact_id TEXT');
    expect(sql).toContain('idx_partner_affect_shadow_suppressions_received');
    expect(sql).toContain('ON partner_affect_shadow_suppressions(partner_contact_id, received_at_ms DESC, id DESC)');
    // Structural facts only: the table stores routing identity and reasons,
    // never a payload/value column that could retain rejected content.
    expect(sql).not.toContain('payload');
  });

  it('creates a companion-scoped analysis-workbench trace ring (vb11)', () => {
    const sql = migrationSql(POSTGRES_ANALYSIS_WORKBENCH_TRACE_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS analysis_workbench_traces');
    expect(sql).toContain('companion_id TEXT NOT NULL');
    expect(sql).toContain('recorded_at_ms BIGINT NOT NULL');
    expect(sql).toContain('trace_json JSONB NOT NULL');
    expect(sql).toContain("CHECK (jsonb_typeof(trace_json) = 'object')");
    // The retention pruning and newest-first read both rely on this index.
    expect(sql).toContain('idx_analysis_workbench_traces_companion_recorded');
    expect(sql).toContain('ON analysis_workbench_traces(companion_id, recorded_at_ms DESC, id DESC)');
  });

  it('creates durable memory deletion proposals and one proposal-linked audit chain', () => {
    const sql = migrationSql(POSTGRES_MEMORY_MIGRATIONS);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_deletion_proposals');
    expect(sql).toContain("'pending_partner_alert', 'pending_operator_validation', 'approved', 'denied', 'restored'");
    expect(sql).toContain('memory_authorization_revision BIGINT NOT NULL');
    expect(sql).toContain('justification_category TEXT NOT NULL');
    expect(sql).toContain('explanation TEXT NOT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_deletion_audit_events');
    expect(sql).toContain("'proposed', 'partner_alerted', 'approved', 'denied', 'deleted', 'restored'");
    expect(sql).toContain("actor_role TEXT NOT NULL CHECK (actor_role IN ('Companion', 'Partner', 'Operator'))");
    expect(sql).toContain('ALTER TABLE l2_memory_delete_versions ADD COLUMN IF NOT EXISTS proposal_id');
    expect(sql).toContain('idx_l2_memory_delete_versions_proposal');
  });

});
