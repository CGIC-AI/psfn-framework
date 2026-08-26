import { screenChatMessageBody } from '../../core/cogsec/intake/chat-message-screening.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { MulticaClaimedTask, MulticaIssue } from './protocol.js';

function channelIdForTask(task: MulticaClaimedTask): string {
  const prefix = `multica:${task.workspace_id}`;
  if (task.issue_id) return `${prefix}:issue:${task.issue_id}`;
  if (task.chat_session_id) return `${prefix}:chat:${task.chat_session_id}`;
  if (task.autopilot_run_id) return `${prefix}:autopilot:${task.autopilot_run_id}`;
  return `${prefix}:task:${task.id}`;
}

function appendSection(lines: string[], heading: string, content: string | undefined): void {
  const normalized = content?.trim();
  if (normalized) lines.push('', `## ${heading}`, normalized);
}

function formatTaskContent(task: MulticaClaimedTask, issue: MulticaIssue | null): string {
  const lines = ['# Multica work item', `Task ID: ${task.id}`, `Task kind: ${task.kind || 'direct'}`];
  if (issue?.identifier) lines.push(`Issue: ${issue.identifier}`);
  if (task.project_title) lines.push(`Project: ${task.project_title}`);
  if (task.squad_name) lines.push(`Squad: ${task.squad_name}`);
  if (task.leader_role_resolved) lines.push(`Squad role: ${task.is_leader_task ? 'leader' : 'worker'}`);
  if (issue) {
    appendSection(lines, 'Issue', [
      issue.title,
      issue.status ? `Status: ${issue.status}` : undefined,
      issue.priority ? `Priority: ${issue.priority}` : undefined,
      issue.description,
    ].filter((entry): entry is string => Boolean(entry)).join('\n'));
  }
  appendSection(lines, 'Handoff', task.handoff_note);
  appendSection(lines, 'New comment', task.trigger_comment_content);
  if (task.coalesced_comments?.length) {
    appendSection(lines, 'Earlier comments included in this run', task.coalesced_comments
      .map(comment => `- ${comment.author_name || 'Multica source'}: ${comment.content || ''}`)
      .join('\n'));
  }
  appendSection(lines, 'Chat message', task.chat_message);
  appendSection(lines, 'Quick-create request', task.quick_create_prompt);
  appendSection(lines, 'Autopilot', task.autopilot_description || task.autopilot_title);
  appendSection(lines, 'Multica assignment context', task.agent?.instructions);
  appendSection(lines, 'Project context', task.project_description);
  return lines.join('\n');
}

function timestampForTask(task: MulticaClaimedTask): Date {
  if (task.created_at) {
    const parsed = new Date(task.created_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export async function toMulticaSubstrateMessage(
  task: MulticaClaimedTask,
  issue: MulticaIssue | null,
  intakeScreening: IntakeScreeningService | null,
): Promise<SubstrateMessage> {
  const channelId = channelIdForTask(task);
  const screened = await screenChatMessageBody({
    content: formatTaskContent(task, issue),
    screening: intakeScreening,
    sourceClass: 'tool_output',
    surface: 'multica',
    channelId,
    messageId: task.id,
    channelPrivacy: 'invite_only',
    channelTopology: 'group',
  });
  return {
    id: task.id,
    channelId,
    channelType: 'multica',
    authorId: `multica:system:${task.workspace_id}`,
    authorName: 'Multica system',
    content: screened.content,
    timestamp: timestampForTask(task),
    isDirectMessage: false,
    ...(task.trigger_comment_id ? { replyToMessageId: task.trigger_comment_id } : {}),
    routing: {
      source: 'multica',
      channelPrivacy: 'invite_only',
      authorIsMachineIntelligence: true,
      ...(screened.snapshot ? { intakeEnvelopes: [screened.snapshot] } : {}),
    },
  };
}
