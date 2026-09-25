import type { TrustLevel } from '../../system/trust/types.js';
import type { ScratchpadEntry, ScratchpadProvenance } from './scratchpad-types.js';

/**
 * Viewer gate for scratchpad notes (psfn-framework-yy0r2). A note renders in,
 * and is readable or mutable from, only the conversation it was written in,
 * unless the companion marked it companion-global. Notes without provenance
 * (written before it was recorded) are visible only at primary trust. Fails
 * closed: a viewer without a conversation id sees only companion-global notes
 * (and unknown ones at primary trust).
 */
export interface ScratchpadViewer {
  channelId?: string;
  trustLevel?: TrustLevel;
}

export function canViewerSeeScratchpadEntry(entry: ScratchpadEntry, viewer: ScratchpadViewer): boolean {
  switch (entry.provenance.scope) {
    case 'companion_global':
      return true;
    case 'conversation':
      return viewer.channelId !== undefined && entry.provenance.channelId === viewer.channelId;
    case 'unknown':
      return viewer.trustLevel === 'primary';
  }
}

export function partitionScratchpadEntriesForViewer(
  entries: readonly ScratchpadEntry[],
  viewer: ScratchpadViewer,
): { visible: ScratchpadEntry[]; withheldCount: number } {
  const visible = entries.filter(entry => canViewerSeeScratchpadEntry(entry, viewer));
  return { visible, withheldCount: entries.length - visible.length };
}

/** Provenance for a new note written from `viewer` (fails closed without a conversation). */
export function resolveScratchpadWriteProvenance(
  scope: 'conversation' | 'companion_global',
  viewer: ScratchpadViewer,
): ScratchpadProvenance {
  if (scope === 'companion_global') return { scope: 'companion_global' };
  if (!viewer.channelId) {
    throw new Error('Scratchpad note needs a current conversation; pass scope "companion_global" to write a note for every conversation');
  }
  return { scope: 'conversation', channelId: viewer.channelId };
}

/** Parse persisted provenance columns; rejects inconsistent rows. */
export function parseScratchpadProvenance(scope: unknown, channelId: unknown, rowId: string): ScratchpadProvenance {
  if (scope === 'conversation' && typeof channelId === 'string' && channelId.length > 0) {
    return { scope: 'conversation', channelId };
  }
  if ((scope === 'companion_global' || scope === 'unknown') && (channelId === null || channelId === undefined)) {
    return { scope };
  }
  throw new Error(`Invalid scratchpad provenance for entry ${rowId}`);
}
