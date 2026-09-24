import type { Pool, QueryResultRow } from 'pg';
import type { FreeTimeLane } from '../../core/scheduler/free-time-lane.js';
import type { RestSilenceStorePort } from '../../core/scheduler/rest-window-policy.js';
import type {
  WorldExplorationInvitationState,
  WorldExplorationStatePort,
} from '../../core/scheduler/world-exploration-state.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
} from '../postgres.js';
import { POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS } from './migrations.js';

const FREE_TIME_LANES: ReadonlySet<string> = new Set<FreeTimeLane>(['quiet_hours', 'idle']);
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface SilenceRow extends QueryResultRow {
  silenced_until_ms: string | number;
}

interface WorldExplorationRow extends QueryResultRow {
  last_invited_at_ms: string | number;
  day_key: string;
  turns_today: number;
}

function nonNegativeSafeInteger(value: string | number, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Scheduler lane state ${field} must be a non-negative safe integer`);
  }
  return number;
}

function requireLane(lane: string): FreeTimeLane {
  if (!FREE_TIME_LANES.has(lane)) {
    throw new Error(`Scheduler rest silence lane "${lane}" is not a known free-time lane`);
  }
  return lane as FreeTimeLane;
}

function requireWorldExplorationState(state: WorldExplorationInvitationState): WorldExplorationInvitationState {
  if (!DAY_KEY_PATTERN.test(state.dayKey)) {
    throw new Error('World exploration state dayKey must be YYYY-MM-DD');
  }
  return {
    lastInvitedAtMs: nonNegativeSafeInteger(state.lastInvitedAtMs, 'lastInvitedAtMs'),
    dayKey: state.dayKey,
    turnsToday: nonNegativeSafeInteger(state.turnsToday, 'turnsToday'),
  };
}

/**
 * Companion-private scheduler lane state (89muv rest silence, orn69 world
 * exploration). The pool is pinned to the companion's own schema, so one
 * companion's state can never be read or written by a sibling.
 */
export class PostgresSchedulerLaneStateStore implements RestSilenceStorePort, WorldExplorationStatePort {
  private constructor(
    private readonly pool: Pool,
    private readonly now: () => number,
  ) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string; now?: () => number } = {},
  ): Promise<PostgresSchedulerLaneStateStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'scheduler-lane-state',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_SCHEDULER_LANE_STATE_MIGRATIONS);
    return new PostgresSchedulerLaneStateStore(pool, options.now ?? Date.now);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async readSilencedUntil(lane: FreeTimeLane): Promise<number | null> {
    const row = await queryOne<SilenceRow>(this.pool, `
      SELECT silenced_until_ms FROM scheduler_rest_silences WHERE lane = $1
    `, [requireLane(lane)]);
    return row ? nonNegativeSafeInteger(row.silenced_until_ms, 'silenced_until_ms') : null;
  }

  async extendSilence(lane: FreeTimeLane, untilMs: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO scheduler_rest_silences (lane, silenced_until_ms, updated_at_ms)
      VALUES ($1, $2, $3)
      ON CONFLICT (lane) DO UPDATE
        SET silenced_until_ms = GREATEST(scheduler_rest_silences.silenced_until_ms, EXCLUDED.silenced_until_ms),
            updated_at_ms = EXCLUDED.updated_at_ms
    `, [requireLane(lane), nonNegativeSafeInteger(untilMs, 'untilMs'), this.now()]);
  }

  async load(): Promise<WorldExplorationInvitationState | null> {
    const row = await queryOne<WorldExplorationRow>(this.pool, `
      SELECT last_invited_at_ms, day_key, turns_today
      FROM scheduler_world_exploration_state
      WHERE singleton_id = 1
    `);
    if (!row) return null;
    return requireWorldExplorationState({
      lastInvitedAtMs: nonNegativeSafeInteger(row.last_invited_at_ms, 'last_invited_at_ms'),
      dayKey: row.day_key,
      turnsToday: row.turns_today,
    });
  }

  async save(state: WorldExplorationInvitationState): Promise<void> {
    const valid = requireWorldExplorationState(state);
    await this.pool.query(`
      INSERT INTO scheduler_world_exploration_state (singleton_id, last_invited_at_ms, day_key, turns_today)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (singleton_id) DO UPDATE
        SET last_invited_at_ms = EXCLUDED.last_invited_at_ms,
            day_key = EXCLUDED.day_key,
            turns_today = EXCLUDED.turns_today
    `, [valid.lastInvitedAtMs, valid.dayKey, valid.turnsToday]);
  }
}
