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
