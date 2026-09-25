import {
  canViewerReadSessionChannel,
  resolveViewerContextFromRequest,
  viewerAdmitsSensitivity,
} from '../../core/session/session-viewer-access.js';
import type { SubagentControlPort } from './port.js';
import type { SubagentRuntimeTaskView, SubagentTaskRecord } from './types.js';

/**
 * Viewer gate for automata tasks (psfn-framework-3o6zu).
 *
 * A worker's task, transcript and result belong to the conversation that
 * spawned it. That conversation can always wait on, message, cancel and
 * inspect its own workers; another conversation sees them only where the
 * transcript disclosure policy would let it read the spawning conversation
 * (canViewerReadSessionChannel). A task without a recorded spawning
 * conversation is visible only where personal material is admitted.
 */
export function canViewerSeeSubagentTask(task: Pick<SubagentTaskRecord, 'sourceContext'>): boolean {
  const viewer = resolveViewerContextFromRequest();
  const sourceChannelId = task.sourceContext?.channelId.trim();
  if (sourceChannelId) return canViewerReadSessionChannel(viewer, sourceChannelId);
  return viewerAdmitsSensitivity('personal', viewer);
}

export function partitionSubagentTaskViews(
  views: readonly SubagentRuntimeTaskView[],
): { visible: SubagentRuntimeTaskView[]; withheldCount: number } {
  const visible = views.filter(view => canViewerSeeSubagentTask(view.task));
  return { visible, withheldCount: views.length - visible.length };
}

/**
 * The task record for `subagentId` when this conversation may act on it.
 * Throws the same "unknown" error for a missing task and for another
 * conversation's task, so a withheld id discloses nothing.
 */
export async function requireVisibleSubagentTask(
  port: SubagentControlPort,
  subagentId: string,
): Promise<SubagentTaskRecord> {
  const task = port.getRuntimeTaskDetail(subagentId)?.view.task
    ?? (await port.inspect(subagentId))?.task;
  if (!task || !canViewerSeeSubagentTask(task)) {
    throw new Error(`Unknown automaton task "${subagentId}" for this conversation.`);
  }
  return task;
}
