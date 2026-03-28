import type { WebFetchLane } from '../gateway/protocol.js';

export interface WebFetchOperations {
  fetch(url: string, options?: { lane?: WebFetchLane; prompt?: string }): Promise<string>;
}
