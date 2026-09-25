import {
  canViewerReadSessionChannel,
  resolveViewerContextFromRequest,
} from '../session/session-viewer-access.js';

/**
 * Viewer gate for companion-wide scheduled items (psfn-framework-o5wf5).
 *
 * Pending follow-ups and care reminders belong to the conversation they are
 * delivered in (their channelId). The schedule tool used to return every one
 * of them, with full content and context summaries, to whatever conversation
 * asked, so a public stranger saw follow-ups formed in trusted rooms. Items
 * are now readable, activatable, and creatable only where the conversation's
 * content is readable (canViewerReadSessionChannel, the transcript gate);
 * items owned by internal channels are private and therefore primary-only.
 */
export function canViewerSeeScheduledItem(item: { channelId: string }): boolean {
  return canViewerReadSessionChannel(resolveViewerContextFromRequest(), item.channelId);
}

export function partitionScheduledItemsForViewer<T extends { channelId: string }>(
  items: readonly T[],
): { visible: T[]; withheldCount: number } {
  const viewer = resolveViewerContextFromRequest();
  const visible = items.filter(item => canViewerReadSessionChannel(viewer, item.channelId));
  return { visible, withheldCount: items.length - visible.length };
}

export function assertViewerMayScheduleInto(channelId: string): void {
  if (!canViewerReadSessionChannel(resolveViewerContextFromRequest(), channelId)) {
    throw new Error(`channel ${channelId} is not reachable from this conversation`);
  }
}
