export interface ScratchpadEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadProvider {
  // Narrow synchronous exemption: prompt assembly reads a local scratchpad view
  // without crossing a runtime-selected backend boundary at call time.
  listScratchpadEntries(limit?: number): ScratchpadEntry[];
}
