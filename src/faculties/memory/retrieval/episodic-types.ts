import type {
  Episode,
  EpisodeArc,
} from '../../../shared/contracts/episodic-memory.js';
import type { EpisodicStorePort } from '../episodic/store-port.js';

export type EpisodicRetrievalStore = Pick<
  EpisodicStorePort,
  'listEpisodes' | 'searchByTime' | 'getEpisode' | 'listEpisodeArcsForEpisode'
>;

export interface EpisodicRetrievalChain {
  rootEpisodeId: string;
  episodes: Episode[];
  arcs: EpisodeArc[];
  score: number;
  matchedTerms: string[];
}

/**
 * One episode or arc a retired-session quarantine withheld from a result.
 * Carries the id and kind only so telemetry can count withheld material
 * without its contents (psfn-framework-ik47b.4).
 */
export interface EpisodicQuarantineWithheld {
  kind: 'episode' | 'arc';
  id: string;
}

export interface EpisodicLexicalSearchResult {
  episode: Episode;
  chain: EpisodicRetrievalChain;
  lexicalScore: number;
  matchedTerms: string[];
  retrievalMode: 'lexical';
}
