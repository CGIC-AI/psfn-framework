import type { Episode, EpisodeArc } from '../../../shared/contracts/episodic-memory.js';
import type { EpisodicRetrievalChain } from './episodic-types.js';

export function cloneEpisode(episode: Episode): Episode {
  return {
    ...episode,
    participantContactIds: [...episode.participantContactIds],
    salience: { ...episode.salience },
    affect: { ...episode.affect, labels: [...episode.affect.labels] },
    themes: [...episode.themes],
    spanRefs: episode.spanRefs.map(ref => ({ ...ref })),
    artifactRefs: episode.artifactRefs.map(ref => ({ ...ref })),
    provenanceRefs: episode.provenanceRefs.map(ref => ({ ...ref })),
  };
}

export function cloneEpisodeArc(arc: EpisodeArc): EpisodeArc {
  return {
    ...arc,
    themes: [...arc.themes],
    spanRefs: arc.spanRefs.map(ref => ({ ...ref })),
    artifactRefs: arc.artifactRefs.map(ref => ({ ...ref })),
    provenanceRefs: arc.provenanceRefs.map(ref => ({ ...ref })),
  };
}

export function cloneEpisodicRetrievalChain(
  chain: EpisodicRetrievalChain,
): EpisodicRetrievalChain {
  return {
    rootEpisodeId: chain.rootEpisodeId,
    episodes: chain.episodes.map(cloneEpisode),
    arcs: chain.arcs.map(cloneEpisodeArc),
    score: chain.score,
    matchedTerms: [...chain.matchedTerms],
  };
}
