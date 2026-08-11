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

export interface EpisodicLexicalSearchResult {
  episode: Episode;
  chain: EpisodicRetrievalChain;
  lexicalScore: number;
  matchedTerms: string[];
  retrievalMode: 'lexical';
}
