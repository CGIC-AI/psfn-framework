import type { SessionSearchHit } from './transcript-projection-port.js';

export interface TranscriptSearchPort {
  searchByKeywords(query: string, limit?: number): SessionSearchHit[];
}
