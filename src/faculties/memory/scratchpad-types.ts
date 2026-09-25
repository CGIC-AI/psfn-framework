/**
 * Where a scratchpad note was written (psfn-framework-yy0r2). The scratchpad
 * renders into every turn's prompt, so each note records its source:
 * - `conversation`: written in one conversation; renders only there.
 * - `companion_global`: the companion explicitly marked it for every
 *   conversation.
 * - `unknown`: written before provenance existed (migration backfill);
 *   renders only for primary trust.
 */
export type ScratchpadProvenance =
  | { scope: 'conversation'; channelId: string }
  | { scope: 'companion_global' }
  | { scope: 'unknown' };

export interface ScratchpadEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  provenance: ScratchpadProvenance;
}
