import type { WebFetchLane } from '../../gateway/protocol.js';

/** Result of a gateway web search (bead psfn-framework-htm9.10). */
export interface WebSearchOperationResult {
  /** Sanitized, tagged search content ready to hand to the model. */
  content: string;
  /** Citation URLs surfaced by the backend, if any. */
  citations: string[];
}

export interface WebFetchOperations {
  fetch(url: string, options?: { lane?: WebFetchLane; prompt?: string }): Promise<string>;
  /**
   * Optional web search. Present only when the gateway exposes a web.search
   * backend (OpenRouter web tools). Absent on backends/mocks that do not wire
   * search, so callers must check for it before use.
   */
  search?(query: string, options?: { maxResults?: number }): Promise<WebSearchOperationResult>;
}
