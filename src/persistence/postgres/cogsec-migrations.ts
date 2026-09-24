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
