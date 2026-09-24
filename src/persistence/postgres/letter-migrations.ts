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
