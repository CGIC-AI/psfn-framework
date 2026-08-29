import type { PoolClient } from 'pg';
import { classifyConversationalActivity } from '../../core/session/conversational-activity.js';
import type { SessionEntry } from '../../core/session/types.js';

interface ConversationActivityRecord {
  logicalSessionId: string;
  messageRevision: number;
  activityKind: ReturnType<typeof classifyConversationalActivity>['kind'];
  processable: boolean;
  occurredAtMs: number;
}

function normalizeOccurredAtMs(value: number): number {
  if (!Number.isFinite(value)) return Date.now();
  return Math.max(0, Math.floor(value));
}

export function projectConversationActivity(
  entry: SessionEntry,
  logicalSessionId: string,
): ConversationActivityRecord {
  const classification = classifyConversationalActivity({
    ...entry,
    channelId: logicalSessionId,
  });
  return {
    logicalSessionId,
    messageRevision: entry.id,
    activityKind: classification.kind,
    processable: classification.processable,
    occurredAtMs: normalizeOccurredAtMs(entry.timestamp),
  };
}

export async function upsertConversationActivity(
  client: PoolClient,
  record: ConversationActivityRecord,
): Promise<void> {
  await client.query(
    `
      INSERT INTO session_conversational_activity (
        logical_session_id, message_revision, activity_kind, processable, occurred_at_ms
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (logical_session_id, message_revision) DO UPDATE SET
        activity_kind = EXCLUDED.activity_kind,
        processable = EXCLUDED.processable,
        occurred_at_ms = EXCLUDED.occurred_at_ms
    `,
    [
      record.logicalSessionId,
      record.messageRevision,
      record.activityKind,
      record.processable,
      record.occurredAtMs,
    ],
  );
}

export async function deleteConversationActivity(
  client: PoolClient,
  logicalSessionId: string,
  messageRevision: number,
): Promise<void> {
  await client.query(
    `DELETE FROM session_conversational_activity
      WHERE logical_session_id = $1 AND message_revision = $2`,
    [logicalSessionId, messageRevision],
  );
}
