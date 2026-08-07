import type { ScratchpadEntry } from '../../faculties/memory/scratchpad-types.js';

export type { ScratchpadEntry } from '../../faculties/memory/scratchpad-types.js';

export interface ScratchpadProvider {
  // Narrow synchronous exemption: prompt assembly reads a local scratchpad view
  // without crossing a runtime-selected backend boundary at call time.
  listScratchpadEntries(limit?: number): ScratchpadEntry[];
}
