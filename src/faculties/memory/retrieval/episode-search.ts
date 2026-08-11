import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import {
  resolveMemoryRetrievalPolicy,
  type MemoryRetrievalPolicy,
} from '../../../system/config/memory-retrieval-policy.js';
import { positiveIntegerOr } from '../../../shared/utils/numeric.js';
import type {
  EpisodeEmbeddingProfile,
  EpisodeEmbeddingStorePort,
} from '../episodic/store-port.js';
import {
  buildEpisodicChainFromRoot,
  searchEpisodicEpisodesLexically,
  type EpisodicLexicalSearchInput,
  type EpisodicRetrievalChain,
  type EpisodicRetrievalStore,
} from './episodic.js';
import {
  filterQuarantinedEpisodicChains,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';

export type HybridEpisodeSearchStore = EpisodicRetrievalStore & EpisodeEmbeddingStorePort;

export type EpisodeSearchModeStatus = 'completed' | 'unavailable' | 'failed' | 'stale';

export interface EpisodeSearchModeReport {
  status: EpisodeSearchModeStatus;
  candidateCount: number;
  error?: string;
  pendingIndexCount?: number;
}

export interface HybridEpisodeSearchResult {
  episode: Episode;
  chain: EpisodicRetrievalChain;
  fusedScore: number;
  lexicalScore?: number;
  semanticSimilarity?: number;
  matchedTerms: string[];
  retrievalModes: Array<'lexical' | 'semantic'>;
}

export interface HybridEpisodeSearchResponse {
  results: HybridEpisodeSearchResult[];
  modes: {
    lexical: EpisodeSearchModeReport;
    semantic: EpisodeSearchModeReport;
  };
  degraded: boolean;
}

export type HybridEpisodeSearchInput = Omit<EpisodicLexicalSearchInput, 'includeChain'> & {
  sessionQuarantineFilter?: MemorySessionQuarantineFilter | null;
};

export interface HybridEpisodeSearchPort {
  search(input: HybridEpisodeSearchInput): Promise<HybridEpisodeSearchResponse>;
}

export interface HybridEpisodeSearchDiagnostic {
  mode: 'semantic';
  status: Exclude<EpisodeSearchModeStatus, 'completed'>;
  error?: string;
  pendingIndexCount?: number;
}

interface HybridEpisodeSearchOptions {
  store: HybridEpisodeSearchStore;
  embeddingService: EmbeddingProviderPort | null;
  profile: EpisodeEmbeddingProfile;
  memoryRetrievalPolicy?: MemoryRetrievalPolicy | (() => MemoryRetrievalPolicy | undefined);
  onDegraded?: (diagnostic: HybridEpisodeSearchDiagnostic) => void;
}

interface SemanticSearchResult {
  entries: Array<{
    episode: Episode;
    chain: EpisodicRetrievalChain;
    similarity: number;
  }>;
  report: EpisodeSearchModeReport;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rankContribution(rank: number, listLength: number): number {
  return listLength > 0 ? (listLength - rank) / listLength : 0;
}

function clampSimilarity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createHybridEpisodeSearch(
  options: HybridEpisodeSearchOptions,
): HybridEpisodeSearchPort {
  if (!Number.isInteger(options.profile.dimensions) || options.profile.dimensions < 1) {
    throw new Error('episode search embedding profile dimensions must be a positive integer');
  }
  if (
    options.embeddingService
    && options.embeddingService.dims !== options.profile.dimensions
  ) {
    throw new Error(
      `episode search embedding profile expects ${options.profile.dimensions} dimensions, `
      + `but provider exposes ${options.embeddingService.dims}`,
    );
  }

  const configuredPolicy = (): MemoryRetrievalPolicy | undefined => (
    typeof options.memoryRetrievalPolicy === 'function'
      ? options.memoryRetrievalPolicy()
      : options.memoryRetrievalPolicy
  );

  const searchSemantic = async (
    input: HybridEpisodeSearchInput,
    candidateLimit: number,
    policy: MemoryRetrievalPolicy,
  ): Promise<SemanticSearchResult> => {
    if (!options.embeddingService) {
      return {
        entries: [],
        report: { status: 'unavailable', candidateCount: 0 },
      };
    }

    try {
      const queryEmbedding = await options.embeddingService.embed(input.query);
      const candidates = await options.store.searchEpisodesByEmbedding({
        profile: options.profile,
        queryEmbedding,
        limit: candidateLimit,
      });
      const entries: SemanticSearchResult['entries'] = [];
      for (const candidate of candidates) {
        if (candidate.similarity < policy.episodic.minRootMatchScore) continue;
        const chain = await buildEpisodicChainFromRoot(options.store, {
          episodeId: candidate.episode.id,
          rootScore: clampSimilarity(candidate.similarity),
          contextText: input.query,
          channelId: input.channelId,
          trustLevel: input.trustLevel,
          channelDisclosure: input.channelDisclosure,
          ...(input.canonicalContactId
            ? { canonicalContactId: input.canonicalContactId }
            : {}),
          ...(input.accessScope ? { accessScope: input.accessScope } : {}),
          ...(input.scopeQuery ? { scopeQuery: input.scopeQuery } : {}),
          scanLimit: input.scanLimit,
          maxDepth: input.maxDepth,
          maxEpisodesPerChain: input.maxEpisodesPerChain,
          memoryRetrievalPolicy: policy,
        });
        if (!chain) continue;
        const [visibleChain] = filterQuarantinedEpisodicChains(
          input.sessionQuarantineFilter ?? null,
          [chain],
        );
        if (!visibleChain) continue;
        entries.push({
          episode: candidate.episode,
          chain: visibleChain,
          similarity: candidate.similarity,
        });
      }

      if (candidates.length === 0) {
        const pending = await options.store.listEpisodeEmbeddingTargets({
          profile: options.profile,
          limit: candidateLimit,
        });
        if (pending.length > 0) {
          return {
            entries,
            report: {
              status: 'stale',
              candidateCount: entries.length,
              pendingIndexCount: pending.length,
            },
          };
        }
      }

      return {
        entries,
        report: { status: 'completed', candidateCount: entries.length },
      };
    } catch (error) {
      return {
        entries: [],
        report: {
          status: 'failed',
          candidateCount: 0,
          error: errorMessage(error),
        },
      };
    }
  };

  return {
    search: async (input): Promise<HybridEpisodeSearchResponse> => {
      const query = input.query.trim();
      if (!query) {
        throw new Error('episode search query must be non-empty');
      }
      const policy = resolveMemoryRetrievalPolicy(
        input.memoryRetrievalPolicy ?? configuredPolicy(),
      );
      const resultLimit = positiveIntegerOr(input.limit, policy.episodic.maxChains);
      const candidateLimit = positiveIntegerOr(input.scanLimit, policy.episodic.scanLimit);
      const quarantineFilter = input.sessionQuarantineFilter ?? null;

      const [lexical, semantic] = await Promise.all([
        searchEpisodicEpisodesLexically(options.store, {
          ...input,
          query,
          limit: candidateLimit,
          memoryRetrievalPolicy: policy,
          includeChain: chain => (
            filterQuarantinedEpisodicChains(quarantineFilter, [chain]).length === 1
          ),
        }),
        searchSemantic({ ...input, query }, candidateLimit, policy),
      ]);

      const lexicalById = new Map(lexical.map((entry, rank) => [
        entry.episode.id,
        { entry, rank },
      ]));
      const semanticById = new Map(semantic.entries.map((entry, rank) => [
        entry.episode.id,
        { entry, rank },
      ]));
      const rootIds = new Set([...lexicalById.keys(), ...semanticById.keys()]);
      const healthyModeCount = semantic.report.status === 'completed' ? 2 : 1;
      const results = [...rootIds].map((episodeId): HybridEpisodeSearchResult => {
        const lexicalMatch = lexicalById.get(episodeId);
        const semanticMatch = semanticById.get(episodeId);
        const lexicalContribution = lexicalMatch
          ? rankContribution(lexicalMatch.rank, lexical.length)
          : 0;
        const semanticContribution = semanticMatch
          ? rankContribution(semanticMatch.rank, semantic.entries.length)
          : 0;
        const episode = lexicalMatch?.entry.episode ?? semanticMatch?.entry.episode;
        const chain = lexicalMatch?.entry.chain ?? semanticMatch?.entry.chain;
        if (!episode || !chain) {
          throw new Error(`episode search fusion lost candidate "${episodeId}"`);
        }
        return {
          episode,
          chain,
          fusedScore: Number(((lexicalContribution + semanticContribution) / healthyModeCount).toFixed(4)),
          ...(lexicalMatch ? { lexicalScore: lexicalMatch.entry.lexicalScore } : {}),
          ...(semanticMatch ? { semanticSimilarity: semanticMatch.entry.similarity } : {}),
          matchedTerms: [...new Set([
            ...(lexicalMatch?.entry.matchedTerms ?? []),
            ...chain.matchedTerms,
          ])].sort(),
          retrievalModes: [
            ...(lexicalMatch ? ['lexical' as const] : []),
            ...(semanticMatch ? ['semantic' as const] : []),
          ],
        };
      }).sort((left, right) => (
        right.fusedScore - left.fusedScore
        || left.episode.id.localeCompare(right.episode.id)
      )).slice(0, resultLimit);

      if (semantic.report.status !== 'completed') {
        options.onDegraded?.({
          mode: 'semantic',
          status: semantic.report.status,
          ...(semantic.report.error ? { error: semantic.report.error } : {}),
          ...(semantic.report.pendingIndexCount !== undefined
            ? { pendingIndexCount: semantic.report.pendingIndexCount }
            : {}),
        });
      }

      return {
        results,
        modes: {
          lexical: { status: 'completed', candidateCount: lexical.length },
          semantic: semantic.report,
        },
        degraded: semantic.report.status !== 'completed',
      };
    },
  };
}
