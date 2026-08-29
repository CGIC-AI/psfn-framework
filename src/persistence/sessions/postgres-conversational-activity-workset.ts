import type { Pool, QueryResultRow } from 'pg';
import {
  CONVERSATIONAL_ACTIVITY_PURPOSES,
  type ClaimedConversationalActivityWorkItem,
  type ConversationalActivityCheckpointInput,
  type ConversationalActivityClaimInput,
  type ConversationalActivityPurpose,
  type ConversationalActivityResumeInput,
  type ConversationalActivityWorkItem,
  type ConversationalActivityWorksetPort,
} from '../../core/session/conversational-activity-workset.js';
import type { ProcessableConversationKind } from '../../core/session/conversational-activity.js';
import { queryRows } from '../postgres.js';

interface WorkItemRow extends QueryResultRow {
  purpose: string;
  logical_session_id: string;
  revision: number | string;
  activity_kind: string;
  checkpoint_revision: number | string;
  claimed_by: string | null;
  claimed_at_ms: number | string | null;
}

const VALID_PURPOSES = new Set<string>(CONVERSATIONAL_ACTIVITY_PURPOSES);
const VALID_PROCESSABLE_KINDS = new Set<string>([
  'direct_message',
  'group_conversation',
  'inter_companion',
  'experiential_free_time',
]);

function requirePurpose(value: unknown): ConversationalActivityPurpose {
  if (typeof value !== 'string' || !VALID_PURPOSES.has(value)) {
    throw new Error(`Unsupported conversational activity purpose: ${String(value)}`);
  }
  return value as ConversationalActivityPurpose;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Conversational activity ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireRevision(value: unknown, field: string, allowZero = false): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new Error(`Conversational activity ${field} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return revision;
}

function requireActivityKind(value: unknown): ProcessableConversationKind {
  if (typeof value !== 'string' || !VALID_PROCESSABLE_KINDS.has(value)) {
    throw new Error(`Unsupported processable conversational activity kind: ${String(value)}`);
  }
  return value as ProcessableConversationKind;
}

function mapWorkItem(row: WorkItemRow): ConversationalActivityWorkItem {
  const claimedAtMs = row.claimed_at_ms === null
    ? undefined
    : requireRevision(row.claimed_at_ms, 'claimedAtMs', true);
  return {
    purpose: requirePurpose(row.purpose),
    logicalSessionId: requireText(row.logical_session_id, 'logicalSessionId'),
    revision: requireRevision(row.revision, 'revision'),
    activityKind: requireActivityKind(row.activity_kind),
    checkpointRevision: requireRevision(row.checkpoint_revision, 'checkpointRevision', true),
    ...(row.claimed_by === null ? {} : { claimantId: requireText(row.claimed_by, 'claimantId') }),
    ...(claimedAtMs === undefined ? {} : { claimedAtMs }),
  };
}

function mapClaimedWorkItem(row: WorkItemRow): ClaimedConversationalActivityWorkItem {
  const item = mapWorkItem(row);
  if (!item.claimantId || item.claimedAtMs === undefined) {
    throw new Error('Persisted conversational activity claim is incomplete');
  }
  return {
    ...item,
    claimantId: item.claimantId,
    claimedAtMs: item.claimedAtMs,
  };
}

export class PostgresConversationalActivityWorkset implements ConversationalActivityWorksetPort {
  constructor(
    private readonly pool: Pool,
    private readonly flushActivityWrites: () => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async enumerate(purpose: ConversationalActivityPurpose): Promise<ConversationalActivityWorkItem[]> {
    const normalizedPurpose = requirePurpose(purpose);
    await this.flushActivityWrites();
    const rows = await queryRows<WorkItemRow>(this.pool, `
      WITH latest_activity AS (
        SELECT DISTINCT ON (logical_session_id)
          logical_session_id,
          message_revision AS revision,
          activity_kind
        FROM session_conversational_activity
        WHERE processable = TRUE
        ORDER BY logical_session_id ASC, message_revision DESC
      )
      SELECT
        $1::text AS purpose,
        latest.logical_session_id,
        latest.revision,
        latest.activity_kind,
        COALESCE(state.checkpoint_revision, 0) AS checkpoint_revision,
        state.claimed_by,
        state.claimed_at_ms
      FROM latest_activity AS latest
      LEFT JOIN session_conversational_workset AS state
        ON state.purpose = $1
       AND state.logical_session_id = latest.logical_session_id
      WHERE latest.revision > COALESCE(state.checkpoint_revision, 0)
      ORDER BY latest.logical_session_id ASC
    `, [normalizedPurpose]);
    return rows.map(mapWorkItem);
  }

  async claim(
    input: ConversationalActivityClaimInput,
  ): Promise<ClaimedConversationalActivityWorkItem | null> {
    const purpose = requirePurpose(input.purpose);
    const logicalSessionId = requireText(input.logicalSessionId, 'logicalSessionId');
    const revision = requireRevision(input.revision, 'revision');
    const claimantId = requireText(input.claimantId, 'claimantId');
    const claimedAtMs = requireRevision(this.now(), 'claimedAtMs', true);
    await this.flushActivityWrites();
    const rows = await queryRows<WorkItemRow>(this.pool, `
      WITH latest_activity AS (
        SELECT activity_kind, message_revision AS revision
        FROM session_conversational_activity
        WHERE logical_session_id = $2
          AND processable = TRUE
        ORDER BY message_revision DESC
        LIMIT 1
      ), claimed AS (
        INSERT INTO session_conversational_workset (
          purpose,
          logical_session_id,
          checkpoint_revision,
          claimed_revision,
          claimed_by,
          claimed_at_ms,
          updated_at_ms
        )
        SELECT $1, $2, 0, latest.revision, $4, $5, $5
        FROM latest_activity AS latest
        WHERE latest.revision = $3
        ON CONFLICT (purpose, logical_session_id) DO UPDATE SET
          claimed_revision = EXCLUDED.claimed_revision,
          claimed_by = EXCLUDED.claimed_by,
          claimed_at_ms = EXCLUDED.claimed_at_ms,
          updated_at_ms = EXCLUDED.updated_at_ms
        WHERE session_conversational_workset.checkpoint_revision < EXCLUDED.claimed_revision
          AND (
            session_conversational_workset.claimed_by IS NULL
            OR session_conversational_workset.claimed_by = EXCLUDED.claimed_by
          )
        RETURNING purpose, logical_session_id, checkpoint_revision,
          claimed_revision, claimed_by, claimed_at_ms
      )
      SELECT
        claimed.purpose,
        claimed.logical_session_id,
        claimed.claimed_revision AS revision,
        latest.activity_kind,
        claimed.checkpoint_revision,
        claimed.claimed_by,
        claimed.claimed_at_ms
      FROM claimed
      JOIN latest_activity AS latest ON latest.revision = claimed.claimed_revision
    `, [purpose, logicalSessionId, revision, claimantId, claimedAtMs]);
    return rows[0] ? mapClaimedWorkItem(rows[0]) : null;
  }

  async resumeClaim(
    input: ConversationalActivityResumeInput,
  ): Promise<ClaimedConversationalActivityWorkItem | null> {
    const purpose = requirePurpose(input.purpose);
    const logicalSessionId = requireText(input.logicalSessionId, 'logicalSessionId');
    const claimantId = requireText(input.claimantId, 'claimantId');
    await this.flushActivityWrites();
    const rows = await queryRows<WorkItemRow>(this.pool, `
      SELECT
        state.purpose,
        state.logical_session_id,
        state.claimed_revision AS revision,
        activity.activity_kind,
        state.checkpoint_revision,
        state.claimed_by,
        state.claimed_at_ms
      FROM session_conversational_workset AS state
      JOIN session_conversational_activity AS activity
        ON activity.logical_session_id = state.logical_session_id
       AND activity.message_revision = state.claimed_revision
       AND activity.processable = TRUE
      WHERE state.purpose = $1
        AND state.logical_session_id = $2
        AND state.claimed_by = $3
        AND state.claimed_revision > state.checkpoint_revision
      LIMIT 1
    `, [purpose, logicalSessionId, claimantId]);
    return rows[0] ? mapClaimedWorkItem(rows[0]) : null;
  }

  async checkpoint(input: ConversationalActivityCheckpointInput): Promise<void> {
    const purpose = requirePurpose(input.purpose);
    const logicalSessionId = requireText(input.logicalSessionId, 'logicalSessionId');
    const revision = requireRevision(input.revision, 'revision');
    const claimantId = requireText(input.claimantId, 'claimantId');
    const updatedAtMs = requireRevision(this.now(), 'updatedAtMs', true);
    const result = await this.pool.query(`
      UPDATE session_conversational_workset
      SET checkpoint_revision = $3,
          claimed_revision = NULL,
          claimed_by = NULL,
          claimed_at_ms = NULL,
          updated_at_ms = $5
      WHERE purpose = $1
        AND logical_session_id = $2
        AND claimed_revision = $3
        AND claimed_by = $4
        AND checkpoint_revision < $3
    `, [purpose, logicalSessionId, revision, claimantId, updatedAtMs]);
    if (result.rowCount !== 1) {
      throw new Error('Conversational activity checkpoint does not match an active claim');
    }
  }
}
