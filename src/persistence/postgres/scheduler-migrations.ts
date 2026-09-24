import { POSTGRES_CHANNEL_TYPE_VALUES } from './postgres-channel-type-values.js';

export const POSTGRES_SCHEDULED_PROMPT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS scheduler_scheduled_prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivery_channel_id TEXT,
    completed_at TEXT,
    CHECK (source IN ('schedule_tool', 'intention_appraisal')),
    CHECK (channel_type IN (${POSTGRES_CHANNEL_TYPE_VALUES})),
    CHECK (status IN ('pending', 'completed')),
    CHECK (
      (status = 'pending' AND completed_at IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL)
    )
  );
  `,
  `ALTER TABLE scheduler_scheduled_prompts
    DROP CONSTRAINT IF EXISTS scheduler_scheduled_prompts_channel_type_check;`,
  `ALTER TABLE scheduler_scheduled_prompts
    ADD CONSTRAINT scheduler_scheduled_prompts_channel_type_check
    CHECK (channel_type IN (${POSTGRES_CHANNEL_TYPE_VALUES}));`,
  `
  ALTER TABLE scheduler_scheduled_prompts
    DROP CONSTRAINT IF EXISTS scheduler_scheduled_prompts_source_check;
  `,
  `
  ALTER TABLE scheduler_scheduled_prompts
    ADD CONSTRAINT scheduler_scheduled_prompts_source_check
    CHECK (source IN ('schedule_tool', 'intention_appraisal'));
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_scheduler_scheduled_prompts_pending_due
    ON scheduler_scheduled_prompts (run_at ASC, created_at ASC, id ASC)
    WHERE status = 'pending';
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_scheduler_scheduled_prompts_created_at
    ON scheduler_scheduled_prompts (created_at DESC, id DESC);
  `,
];

/** Companion-private availability projection and non-preempting inbound queue (a95pm). */
export const POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS companion_availability_state (
    singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
    state TEXT NOT NULL CHECK (state IN ('available', 'idle', 'do_not_disturb')),
    since_ms BIGINT NOT NULL CHECK (since_ms >= 0),
    revision BIGINT NOT NULL CHECK (revision >= 0)
  );
  `,
  `
  INSERT INTO companion_availability_state (singleton_id, state, since_ms, revision)
  VALUES (1, 'available', 0, 0)
  ON CONFLICT (singleton_id) DO NOTHING;
  `,
  `
  CREATE TABLE IF NOT EXISTS companion_protected_message_queue (
    sequence BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    enqueued_at_ms BIGINT NOT NULL CHECK (enqueued_at_ms >= 0),
    message_json JSONB NOT NULL,
    UNIQUE (channel_id, message_id)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_companion_protected_message_queue_fifo
    ON companion_protected_message_queue (sequence ASC);
  `,
];

/**
 * Companion-private scheduler lane state that must survive restart
 * (psfn-framework-89muv rest silence, psfn-framework-orn69 world exploration).
 */
export const POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS scheduler_rest_silences (
    lane TEXT PRIMARY KEY,
    silenced_until_ms BIGINT NOT NULL CHECK (silenced_until_ms >= 0),
    updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS scheduler_world_exploration_state (
    singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
    last_invited_at_ms BIGINT NOT NULL CHECK (last_invited_at_ms >= 0),
    day_key TEXT NOT NULL CHECK (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    turns_today INTEGER NOT NULL CHECK (turns_today >= 0)
  );
  `,
];
