import type { SessionSearchHit, TranscriptSearchOptions } from './transcript-projection-port.js';

export interface TranscriptSearchPort {
  searchByKeywords(query: string, limit?: number, options?: TranscriptSearchOptions): Promise<SessionSearchHit[]>;
}
