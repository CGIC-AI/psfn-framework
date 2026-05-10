import {
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
  type EpisodeArtifactRef,
  type EpisodeProvenanceRef,
  type EpisodeSpanRef,
} from '../../../shared/contracts/episodic-memory.js';
import { trustAtLeast, type ChannelVisibility, type TrustLevel } from '../../../system/trust/types.js';
import type { EpisodeArcListOptions, EpisodeListOptions } from '../episodic/store.js';
import type { MemoryScopeQuery } from '../types.js';

type Awaitable<T> = T | Promise<T>;

export interface EpisodicRetrievalStore {
  listEpisodes(options?: EpisodeListOptions): Awaitable<Episode[]>;
  getEpisode(id: string): Awaitable<Episode | undefined>;
  listEpisodeArcsForEpisode(episodeId: string, options?: EpisodeArcListOptions): Awaitable<EpisodeArc[]>;
}

export interface EpisodicRetrievalChain {
  rootEpisodeId: string;
  episodes: Episode[];
  arcs: EpisodeArc[];
  score: number;
  matchedTerms: string[];
}

export interface EpisodicRetrievalInput {
  contextText: string;
  channelId: string;
  trustLevel: TrustLevel;
  channelVisibility: ChannelVisibility;
  canonicalContactId?: string;
  scopeQuery?: MemoryScopeQuery;
  scanLimit?: number;
  maxChains?: number;
  maxDepth?: number;
  maxEpisodesPerChain?: number;
}

interface EpisodeCandidate {
  episode: Episode;
  score: number;
  matchedTerms: string[];
}

const DEFAULT_SCAN_LIMIT = 1000;
const DEFAULT_MAX_CHAINS = 3;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_EPISODES_PER_CHAIN = 5;
const ARC_SCAN_LIMIT = 8;
const MIN_ROOT_MATCH_SCORE = 0.18;
const MIN_RELATED_MATCH_SCORE = 0.08;
const QUERY_STOP_WORDS = new Set([
  'about',
  'again',
  'also',
  'anything',
  'can',
  'chain',
  'could',
  'did',
  'does',
  'for',
  'from',
  'happen',
  'happened',
  'have',
  'into',
  'know',
  'memory',
  'more',
  'our',
  'please',
  'recall',
  'remember',
  'that',
  'the',
  'their',
  'there',
  'this',
  'through',
  'was',
  'were',
  'what',
  'when',
  'with',
  'would',
  'you',
  'your',
]);

export async function retrieveEpisodicChains(
  store: EpisodicRetrievalStore,
  input: EpisodicRetrievalInput,
): Promise<EpisodicRetrievalChain[]> {
  const queryTokens = tokenizeQuery(input.contextText);
  const normalizedQuery = normalizeSearchText(input.contextText);
  if (queryTokens.length === 0 && !input.scopeQuery) {
    return [];
  }

  const maxChains = normalizePositiveInteger(input.maxChains, DEFAULT_MAX_CHAINS);
  const maxDepth = normalizeNonNegativeInteger(input.maxDepth, DEFAULT_MAX_DEPTH);
  const maxEpisodesPerChain = normalizePositiveInteger(
    input.maxEpisodesPerChain,
    DEFAULT_MAX_EPISODES_PER_CHAIN,
  );
  const episodes = (await store.listEpisodes({
    limit: normalizePositiveInteger(input.scanLimit, DEFAULT_SCAN_LIMIT),
  })).map(cloneEpisode);
  const episodeIndex = new Map<string, Episode>();
  const roots = episodes
    .map((episode) => parseEpisode(episode))
    .filter(episode => isEpisodeVisibleForTurn(episode, input))
    .map(episode => scoreEpisode(episode, queryTokens, normalizedQuery, input.scopeQuery))
    .filter((candidate): candidate is EpisodeCandidate => (
      candidate !== null && candidate.score >= MIN_ROOT_MATCH_SCORE
    ))
    .sort(compareEpisodeCandidates);

  for (const episode of episodes) {
    const parsed = parseEpisode(episode);
    episodeIndex.set(parsed.id, parsed);
  }

  const chains: EpisodicRetrievalChain[] = [];
  const usedEpisodeIds = new Set<string>();
  for (const root of roots) {
    if (usedEpisodeIds.has(root.episode.id)) continue;
    const chain = await buildEpisodeChain({
      store,
      root,
      input,
      queryTokens,
      normalizedQuery,
      episodeIndex,
      maxDepth,
      maxEpisodesPerChain,
    });
    if (chain.episodes.length === 0) continue;
    chains.push(chain);
    for (const episode of chain.episodes) {
      usedEpisodeIds.add(episode.id);
    }
    if (chains.length >= maxChains) break;
  }

  return chains.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.rootEpisodeId.localeCompare(right.rootEpisodeId);
  });
}

export function cloneEpisodicRetrievalChain(chain: EpisodicRetrievalChain): EpisodicRetrievalChain {
  return {
    rootEpisodeId: chain.rootEpisodeId,
    episodes: chain.episodes.map(cloneEpisode),
    arcs: chain.arcs.map(cloneEpisodeArc),
    score: chain.score,
    matchedTerms: [...chain.matchedTerms],
  };
}

export function countEpisodicChainEpisodes(chains: readonly EpisodicRetrievalChain[]): number {
  const ids = new Set<string>();
  for (const chain of chains) {
    for (const episode of chain.episodes) {
      ids.add(episode.id);
    }
  }
  return ids.size;
}

export function collectEpisodicChainProvenanceRefs(
  chains: readonly EpisodicRetrievalChain[],
): string[] {
  const refs = new Set<string>();
  for (const chain of chains) {
    for (const episode of chain.episodes) {
      refs.add(`l01_episode:${episode.id}`);
      collectSpanRefProvenance(episode.spanRefs, refs);
      collectArtifactRefProvenance(episode.artifactRefs, refs);
      collectExplicitProvenance(episode.provenanceRefs, refs);
    }
    for (const arc of chain.arcs) {
      refs.add(`l01_episode_arc:${arc.id}`);
      collectSpanRefProvenance(arc.spanRefs, refs);
      collectArtifactRefProvenance(arc.artifactRefs, refs);
      collectExplicitProvenance(arc.provenanceRefs, refs);
    }
  }
  return [...refs].sort();
}

async function buildEpisodeChain(input: {
  store: EpisodicRetrievalStore;
  root: EpisodeCandidate;
  input: EpisodicRetrievalInput;
  queryTokens: string[];
  normalizedQuery: string;
  episodeIndex: Map<string, Episode>;
  maxDepth: number;
  maxEpisodesPerChain: number;
}): Promise<EpisodicRetrievalChain> {
  const episodes: Episode[] = [cloneEpisode(input.root.episode)];
  const arcs: EpisodeArc[] = [];
  const matchedTerms = new Set(input.root.matchedTerms);
  const visited = new Set([input.root.episode.id]);
  const queue: Array<{ episode: Episode; depth: number }> = [
    { episode: input.root.episode, depth: 0 },
  ];

  while (queue.length > 0 && episodes.length < input.maxEpisodesPerChain) {
    const current = queue.shift();
    if (!current || current.depth >= input.maxDepth) continue;

    const relatedArcs = (await input.store.listEpisodeArcsForEpisode(current.episode.id, {
      direction: 'both',
      limit: ARC_SCAN_LIMIT,
    }))
      .map(arc => parseEpisodeArc(cloneEpisodeArc(arc)))
      .sort(compareArcs);

    for (const arc of relatedArcs) {
      if (episodes.length >= input.maxEpisodesPerChain) break;
      const relatedEpisodeId = arc.sourceEpisodeId === current.episode.id
        ? arc.targetEpisodeId
        : arc.sourceEpisodeId;
      if (visited.has(relatedEpisodeId)) continue;

      const related = await resolveEpisode(input.store, input.episodeIndex, relatedEpisodeId, arc.id);
      if (!isEpisodeVisibleForTurn(related, input.input)) continue;
      if (input.input.scopeQuery?.mode === 'only' && !episodeMatchesScopeQuery(related, input.input.scopeQuery)) {
        continue;
      }

      const candidate = scoreEpisode(
        related,
        input.queryTokens,
        input.normalizedQuery,
        input.input.scopeQuery,
      );
      if (!isRelatedEpisodeUseful(input.root, arc, candidate, input.queryTokens)) {
        continue;
      }

      visited.add(related.id);
      episodes.push(cloneEpisode(related));
      arcs.push(cloneEpisodeArc(arc));
      for (const term of candidate?.matchedTerms ?? []) {
        matchedTerms.add(term);
      }
      queue.push({ episode: related, depth: current.depth + 1 });
    }
  }

  const arcScore = arcs.reduce((sum, arc) => sum + (arc.salience * arc.confidence * 0.12), 0);
  const relatedScore = episodes
    .slice(1)
    .map(episode => scoreEpisode(episode, input.queryTokens, input.normalizedQuery, input.input.scopeQuery)?.score ?? 0)
    .reduce((sum, score) => sum + (score * 0.35), 0);

  return {
    rootEpisodeId: input.root.episode.id,
    episodes,
    arcs,
    score: Number((input.root.score + relatedScore + arcScore).toFixed(4)),
    matchedTerms: [...matchedTerms].sort(),
  };
}

async function resolveEpisode(
  store: EpisodicRetrievalStore,
  episodeIndex: Map<string, Episode>,
  episodeId: string,
  arcId: string,
): Promise<Episode> {
  const indexed = episodeIndex.get(episodeId);
  if (indexed) return indexed;

  const episode = await store.getEpisode(episodeId);
  if (!episode) {
    throw new Error(`episode arc "${arcId}" references unavailable episode "${episodeId}"`);
  }
  const parsed = parseEpisode(cloneEpisode(episode));
  episodeIndex.set(parsed.id, parsed);
  return parsed;
}

function scoreEpisode(
  episode: Episode,
  queryTokens: readonly string[],
  normalizedQuery: string,
  scopeQuery?: MemoryScopeQuery,
): EpisodeCandidate | null {
  const matchedTerms = new Set<string>();
  let weightedMatches = 0;

  const weightedFields = [
    { weight: 2.4, tokens: tokenizeSearchText(episode.themes.join(' ')) },
    { weight: 2.0, tokens: tokenizeSearchText(episode.title) },
    { weight: 1.3, tokens: tokenizeSearchText(episode.landmark) },
    { weight: 0.8, tokens: tokenizeSearchText(episode.affect.labels.join(' ')) },
  ];

  for (const queryToken of queryTokens) {
    let bestWeight = 0;
    for (const field of weightedFields) {
      if (field.tokens.some(token => tokensMatch(token, queryToken))) {
        bestWeight = Math.max(bestWeight, field.weight);
      }
    }
    if (bestWeight > 0) {
      matchedTerms.add(queryToken);
      weightedMatches += bestWeight;
    }
  }

  const scopeMatch = episodeMatchesScopeQuery(episode, scopeQuery);
  const searchableText = normalizeSearchText([
    episode.title,
    episode.landmark,
    episode.themes.join(' '),
    episode.affect.labels.join(' '),
  ].join(' '));
  const phraseBoost = normalizedQuery.length >= 6 && searchableText.includes(normalizedQuery)
    ? 0.25
    : 0;
  const queryDenominator = Math.max(1, queryTokens.length * 2.4);
  const lexicalScore = weightedMatches / queryDenominator;
  const score = Math.min(
    1,
    lexicalScore
      + phraseBoost
      + (episode.salience.score * 0.22)
      + (scopeMatch ? 0.18 : 0),
  );

  if (matchedTerms.size === 0 && !scopeMatch) {
    return null;
  }

  return {
    episode,
    score,
    matchedTerms: [...matchedTerms],
  };
}

function isRelatedEpisodeUseful(
  root: EpisodeCandidate,
  arc: EpisodeArc,
  related: EpisodeCandidate | null,
  queryTokens: readonly string[],
): boolean {
  if (related && related.score >= MIN_RELATED_MATCH_SCORE) {
    return true;
  }
  const queryThemeMatch = arc.themes.some(theme => (
    queryTokens.some(token => tokensMatch(normalizeToken(theme), token))
  ));
  if (queryThemeMatch) {
    return true;
  }
  const rootThemeSet = new Set(root.episode.themes.map(normalizeToken));
  const sharedRootTheme = arc.themes.some(theme => rootThemeSet.has(normalizeToken(theme)));
  if (sharedRootTheme && arc.confidence >= 0.4) {
    return true;
  }
  return (
    (arc.arcKind === 'continuation' || arc.arcKind === 'causal' || arc.arcKind === 'resolution')
    && arc.confidence >= 0.45
  );
}

function isEpisodeVisibleForTurn(episode: Episode, input: EpisodicRetrievalInput): boolean {
  if (episode.channelId === input.channelId) {
    return true;
  }
  if (input.scopeQuery?.mode === 'only' && !episodeMatchesScopeQuery(episode, input.scopeQuery)) {
    return false;
  }

  const contactMatch = input.canonicalContactId !== undefined
    && episode.participantContactIds.includes(input.canonicalContactId);
  if (!contactMatch) {
    return false;
  }

  return input.channelVisibility !== 'broadcast' && trustAtLeast(input.trustLevel, 'trusted');
}

function episodeMatchesScopeQuery(episode: Episode, scopeQuery: MemoryScopeQuery | undefined): boolean {
  if (!scopeQuery) return false;
  const refMatch = scopeQuery.refs?.some((ref) => {
    if (ref.kind === 'conversation') {
      return episode.threadId === ref.id || episode.channelId === ref.id;
    }
    if (ref.kind === 'contact') {
      return episode.participantContactIds.includes(ref.id);
    }
    return false;
  }) ?? false;
  if (refMatch) return true;

  const episodeThemeSet = new Set(episode.themes.map(normalizeToken));
  return scopeQuery.tags?.some(tag => episodeThemeSet.has(normalizeToken(tag))) ?? false;
}

function compareEpisodeCandidates(left: EpisodeCandidate, right: EpisodeCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  if (right.episode.salience.score !== left.episode.salience.score) {
    return right.episode.salience.score - left.episode.salience.score;
  }
  if (right.episode.startedAt !== left.episode.startedAt) {
    return right.episode.startedAt.localeCompare(left.episode.startedAt);
  }
  return left.episode.id.localeCompare(right.episode.id);
}

function compareArcs(left: EpisodeArc, right: EpisodeArc): number {
  const rightScore = right.salience * right.confidence;
  const leftScore = left.salience * left.confidence;
  if (rightScore !== leftScore) return rightScore - leftScore;
  if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.id.localeCompare(right.id);
}

function tokenizeQuery(value: string): string[] {
  return [...new Set(tokenizeSearchText(value).filter(token => !QUERY_STOP_WORDS.has(token)))];
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value).match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [];
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '_');
}

function tokensMatch(candidateToken: string, queryToken: string): boolean {
  if (candidateToken === queryToken) return true;
  const candidateStem = singularizeToken(candidateToken);
  const queryStem = singularizeToken(queryToken);
  if (candidateStem === queryStem) return true;
  return (
    candidateToken.length >= 5
    && queryToken.length >= 5
    && (candidateToken.includes(queryToken) || queryToken.includes(candidateToken))
  );
}

function singularizeToken(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  return normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  return normalized >= 0 ? normalized : fallback;
}

function collectSpanRefProvenance(refs: readonly EpisodeSpanRef[], out: Set<string>): void {
  for (const ref of refs) {
    out.add(`l0_span:${ref.spanId}`);
    if (ref.sessionId) out.add(`session:${ref.sessionId}`);
    if (ref.startTurnId) out.add(`turn:${ref.startTurnId}`);
    if (ref.endTurnId) out.add(`turn:${ref.endTurnId}`);
  }
}

function collectArtifactRefProvenance(refs: readonly EpisodeArtifactRef[], out: Set<string>): void {
  for (const ref of refs) {
    out.add(`l0_artifact:${ref.artifactId}`);
  }
}

function collectExplicitProvenance(refs: readonly EpisodeProvenanceRef[], out: Set<string>): void {
  for (const ref of refs) {
    out.add(`${ref.kind}:${ref.refId}`);
  }
}

function cloneEpisode(episode: Episode): Episode {
  return {
    ...episode,
    participantContactIds: [...episode.participantContactIds],
    salience: { ...episode.salience },
    affect: {
      ...episode.affect,
      labels: [...episode.affect.labels],
    },
    themes: [...episode.themes],
    spanRefs: episode.spanRefs.map(ref => ({ ...ref })),
    artifactRefs: episode.artifactRefs.map(ref => ({ ...ref })),
    provenanceRefs: episode.provenanceRefs.map(ref => ({ ...ref })),
  };
}

function cloneEpisodeArc(arc: EpisodeArc): EpisodeArc {
  return {
    ...arc,
    themes: [...arc.themes],
    spanRefs: arc.spanRefs.map(ref => ({ ...ref })),
    artifactRefs: arc.artifactRefs.map(ref => ({ ...ref })),
    provenanceRefs: arc.provenanceRefs.map(ref => ({ ...ref })),
  };
}
