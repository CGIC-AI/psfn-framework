import type { SessionEntry } from '../../../core/session/types.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeUpdateInput,
  EpisodicStorePort,
} from './store.js';

const log = createComponentLogger('SleepConsolidation');

export interface SleepConsolidationSessionReader {
  getRecentMessages(channelId: string, limit: number): SessionEntry[];
}

export interface SleepCycleConsolidationOptions {
  now?: () => Date;
  /** How far back the nightly pass reviews episodes. */
  reviewWindowMs?: number;
  /** Episodes in the same scope closer than this are one sitting and merge. */
  adjacencyGapMs?: number;
  /** How far back the bounded LLM cleanup reviews episodes. */
  refinementWindowMs?: number;
  /** Cap on LLM refinement calls per run. */
  maxRefinementsPerRun?: number;
  transcriptMessageLimit?: number;
  maxTranscriptCharsPerEpisode?: number;
}

export interface SleepCycleConsolidationRunInput {
  sessionId: string;
  sourceMessageId?: string;
}

export interface SleepCycleConsolidationResult {
  reviewedEpisodes: number;
  mergeChains: number;
  mergedAwayEpisodes: number;
  refinedEpisodes: number;
  refinementSkipped: number;
}

interface EpisodeRefinement {
  title: string;
  landmark: string;
  themes: string[];
  salienceScore: number;
  salienceReason: string;
}

// Keep deterministic repair broad enough to fold historical canonical overlap
// backlogs; LLM refinement remains separately bounded below.
const DEFAULT_REVIEW_WINDOW_MS = 60 * 24 * 60 * 60_000;
const DEFAULT_REFINEMENT_WINDOW_MS = 36 * 60 * 60_000;
const DEFAULT_ADJACENCY_GAP_MS = 45 * 60_000;
const DEFAULT_MAX_REFINEMENTS_PER_RUN = 8;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 200;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 6000;
const REVIEW_EPISODE_LIMIT = 200;
const MAX_TRACKED_REFINED_EPISODE_IDS = 400;
const SLEEP_CONSOLIDATION_PROCESSOR = 'sleep_consolidation';

const REFINEMENT_SYSTEM_PROMPT = [
  'You refine one episodic memory record for a long-lived companion.',
  'You receive an episode (machine-generated title, landmark, themes, salience) plus a transcript excerpt of the conversation it covers.',
  'Return strict JSON only:',
  '{',
  '  "title": "what this stretch of conversation was ABOUT, in a short thematic phrase — never a verbatim message quote",',
  '  "landmark": "one or two sentences of narrative meaning: what happened between the participants and why it mattered — never message counts or statistics",',
  '  "themes": ["3 to 6 semantic topics, lowercase"],',
  '  "salience": 0.0,',
  '  "salience_reason": "one sentence"',
  '}',
  'Salience is significance to the relationship and to long-term memory, from 0 to 1:',
  '- emotionally important, intimate, or milestone moments score high (0.75-0.95) even when brief',
  '- meaningful shared work, decisions, or discoveries score mid (0.5-0.75)',
  '- routine logistics, status checks, and task chatter score low (0.2-0.5)',
  'Length of the exchange must not drive the score.',
  'Ground everything in the transcript excerpt; never invent events.',
].join('\n');

function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function parseInstant(value: string): number {
  return Date.parse(value);
}

function mergeUnique<T>(left: readonly T[], right: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of [...left, ...right]) {
    const itemKey = key(item);
    if (!seen.has(itemKey)) {
      seen.set(itemKey, item);
    }
  }
  return [...seen.values()];
}

function sameEpisodeScope(left: Episode, right: Episode): boolean {
  const sameChannel = (left.channelId ?? '') === (right.channelId ?? '');
  const sameThread = (left.threadId ?? '') === (right.threadId ?? '');
  if (!sameChannel || !sameThread) return false;
  return [...left.participantContactIds].sort().join(',')
    === [...right.participantContactIds].sort().join(',');
}

function sameSitting(chain: readonly Episode[], next: Episode, adjacencyGapMs: number): boolean {
  if (chain.length === 0) return false;
  const anchor = chain[0];
  if (!sameEpisodeScope(anchor, next)) return false;
  const chainEndMs = Math.max(...chain.map(episode => parseInstant(episode.endedAt)));
  const gapMs = parseInstant(next.startedAt) - chainEndMs;
  return gapMs <= adjacencyGapMs;
}

/** Chains of time-adjacent same-scope episodes; chains of length >= 2 merge into their head. */
export function buildMergeChains(episodes: readonly Episode[], adjacencyGapMs: number): Episode[][] {
  const ordered = [...episodes].sort((left, right) => (
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  ));
  const chains: Episode[][] = [];
  let currentChain: Episode[] = [];
  for (const episode of ordered) {
    if (sameSitting(currentChain, episode, adjacencyGapMs)) {
      currentChain.push(episode);
    } else {
      currentChain = [episode];
      chains.push(currentChain);
    }
  }
  return chains;
}

function mergeChainIntoHead(chain: readonly Episode[]): EpisodeUpdateInput {
  const head = chain[0];
  return chain.slice(1).reduce<EpisodeUpdateInput>((merged, episode) => ({
    ...merged,
    startedAt: merged.startedAt <= episode.startedAt ? merged.startedAt : episode.startedAt,
    endedAt: merged.endedAt >= episode.endedAt ? merged.endedAt : episode.endedAt,
    participantContactIds: [...new Set([...merged.participantContactIds, ...episode.participantContactIds])].sort(),
    salience: {
      score: Math.max(merged.salience.score, episode.salience.score),
      novelty: Math.max(merged.salience.novelty ?? 0, episode.salience.novelty ?? 0),
      emotionalIntensity: Math.max(
        merged.salience.emotionalIntensity ?? 0,
        episode.salience.emotionalIntensity ?? 0,
      ),
    },
    affect: {
      ...merged.affect,
      arousal: Math.max(merged.affect.arousal ?? 0, episode.affect.arousal ?? 0),
      labels: [...new Set([...merged.affect.labels, ...episode.affect.labels])],
    },
    themes: [...new Set([...merged.themes, ...episode.themes])],
    spanRefs: mergeUnique(merged.spanRefs, episode.spanRefs, ref => ref.spanId),
    artifactRefs: mergeUnique(merged.artifactRefs, episode.artifactRefs, ref => ref.artifactId),
    provenanceRefs: mergeUnique(
      merged.provenanceRefs,
      episode.provenanceRefs,
      ref => `${ref.kind}:${ref.refId}:${ref.note ?? ''}`,
    ),
  }), {
    id: head.id,
    title: head.title,
    landmark: head.landmark,
    startedAt: head.startedAt,
    endedAt: head.endedAt,
    threadId: head.threadId,
    channelId: head.channelId,
    participantContactIds: head.participantContactIds,
    salience: head.salience,
    affect: head.affect,
    themes: head.themes,
    spanRefs: head.spanRefs,
    artifactRefs: head.artifactRefs,
    provenanceRefs: head.provenanceRefs,
  });
}

function extractJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('response contains no JSON object');
  }
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response JSON is not an object');
  }
  return parsed as Record<string, unknown>;
}

function parseRefinement(content: string): EpisodeRefinement {
  const raw = extractJsonObject(content);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 160) {
    throw new Error('refinement title must be a non-empty string up to 160 chars');
  }
  const landmark = typeof raw.landmark === 'string' ? raw.landmark.trim() : '';
  if (!landmark || landmark.length > 600) {
    throw new Error('refinement landmark must be a non-empty string up to 600 chars');
  }
  if (!Array.isArray(raw.themes)) {
    throw new Error('refinement themes must be an array');
  }
  const themes = raw.themes
    .map(theme => (typeof theme === 'string' ? theme.trim().toLowerCase() : ''))
    .filter(theme => theme.length > 0 && theme.length <= 64)
    .slice(0, 8);
  if (themes.length === 0) {
    throw new Error('refinement themes must contain at least one non-empty string');
  }
  const salience = raw.salience;
  if (typeof salience !== 'number' || !Number.isFinite(salience) || salience < 0 || salience > 1) {
    throw new Error('refinement salience must be a finite number in [0, 1]');
  }
  const salienceReason = typeof raw.salience_reason === 'string' ? raw.salience_reason.trim() : '';
  return {
    title,
    landmark,
    themes: [...new Set(themes)],
    salienceScore: Math.round(salience * 100) / 100,
    salienceReason,
  };
}

function transcriptExcerptForEpisode(
  episode: Episode,
  entries: readonly SessionEntry[],
  maxChars: number,
): string {
  const startMs = parseInstant(episode.startedAt);
  const endMs = parseInstant(episode.endedAt);
  const inSpan = entries.filter(entry => (
    (entry.role === 'user' || entry.role === 'assistant')
    && entry.timestamp >= startMs
    && entry.timestamp <= endMs
  ));
  if (inSpan.length === 0) return '';
  const lines = inSpan.map(entry => `${entry.authorName || entry.role}: ${entry.content}`);
  let excerpt = lines.join('\n');
  if (excerpt.length > maxChars) {
    // Keep the head and tail of the span; the middle is least likely to
    // change what the episode is about.
    const half = Math.floor(maxChars / 2);
    excerpt = `${excerpt.slice(0, half)}\n[...]\n${excerpt.slice(-half)}`;
  }
  return excerpt;
}

/**
 * Nightly sleep-cycle consolidation (charter 6.21): deterministically merges
 * time-adjacent same-scope episodes (one sitting should be one episode), then
 * runs a bounded background-model cleanup pass that replaces machine titles,
 * stats landmarks, and token-frequency themes with thematic ones and
 * recalibrates salience by significance instead of length. The companion's
 * own first-person meaning pass over these episodes is a separate stage
 * (0a5.4) and intentionally does not happen here.
 */
export class SleepCycleEpisodeConsolidator {
  private readonly store: EpisodicStorePort;
  private readonly sessionReader: SleepConsolidationSessionReader;
  private readonly llmProvider: Pick<LLMProviderPort, 'complete'>;
  private readonly now: () => Date;
  private readonly reviewWindowMs: number;
  private readonly adjacencyGapMs: number;
  private readonly refinementWindowMs: number;
  private readonly maxRefinementsPerRun: number;
  private readonly transcriptMessageLimit: number;
  private readonly maxTranscriptCharsPerEpisode: number;

  constructor(
    store: EpisodicStorePort,
    sessionReader: SleepConsolidationSessionReader,
    llmProvider: Pick<LLMProviderPort, 'complete'>,
    options: SleepCycleConsolidationOptions = {},
  ) {
    this.store = store;
    this.sessionReader = sessionReader;
    this.llmProvider = llmProvider;
    this.now = options.now ?? (() => new Date());
    this.reviewWindowMs = options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    this.adjacencyGapMs = options.adjacencyGapMs ?? DEFAULT_ADJACENCY_GAP_MS;
    this.refinementWindowMs = options.refinementWindowMs ?? DEFAULT_REFINEMENT_WINDOW_MS;
    this.maxRefinementsPerRun = options.maxRefinementsPerRun ?? DEFAULT_MAX_REFINEMENTS_PER_RUN;
    this.transcriptMessageLimit = options.transcriptMessageLimit ?? DEFAULT_TRANSCRIPT_MESSAGE_LIMIT;
    this.maxTranscriptCharsPerEpisode = options.maxTranscriptCharsPerEpisode ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  }

  async run(input: SleepCycleConsolidationRunInput): Promise<SleepCycleConsolidationResult> {
    const nowMs = this.now().getTime();
    const episodes = await this.store.searchByTime({
      from: toIsoInstant(nowMs - this.reviewWindowMs),
      to: toIsoInstant(nowMs),
      limit: REVIEW_EPISODE_LIMIT,
    });

    const result: SleepCycleConsolidationResult = {
      reviewedEpisodes: episodes.length,
      mergeChains: 0,
      mergedAwayEpisodes: 0,
      refinedEpisodes: 0,
      refinementSkipped: 0,
    };
    if (episodes.length === 0) {
      return result;
    }

    const watermarkScope = {
      processor: SLEEP_CONSOLIDATION_PROCESSOR,
      sourceRef: input.sessionId,
    };
    const watermark = await this.store.getProcessingWatermark(watermarkScope);
    const refinedEpisodeIds = new Set<string>(
      Array.isArray(watermark?.nextWatermarkJson.refinedEpisodeIds)
        ? (watermark.nextWatermarkJson.refinedEpisodeIds as unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
        : [],
    );

    // Stage 1 — deterministic: one sitting becomes one episode.
    const consolidated: Episode[] = [];
    for (const chain of buildMergeChains(episodes, this.adjacencyGapMs)) {
      if (chain.length === 1) {
        consolidated.push(chain[0]);
        continue;
      }
      const head = chain[0];
      const merged = await this.store.updateEpisode(mergeChainIntoHead(chain));
      result.mergeChains += 1;
      // A merged-into episode changes content, so it deserves re-refinement.
      refinedEpisodeIds.delete(head.id);
      for (const folded of chain.slice(1)) {
        await this.store.markEpisodeMerged(folded.id, head.id);
        await this.store.writeEpisodeLineage({
          sourceEpisodeId: folded.id,
          targetEpisodeId: head.id,
          relation: 'merges',
          confidence: 0.9,
          reason: 'sleep-cycle consolidation: time-adjacent same-scope episodes are one sitting',
          provenanceRefs: folded.provenanceRefs,
          lineageJson: {
            processor: SLEEP_CONSOLIDATION_PROCESSOR,
            adjacencyGapMs: this.adjacencyGapMs,
            foldedTitle: folded.title,
            foldedSpan: { startedAt: folded.startedAt, endedAt: folded.endedAt },
          },
        });
        result.mergedAwayEpisodes += 1;
      }
      consolidated.push(merged);
    }

    // Stage 2 — bounded LLM cleanup of titles, landmarks, themes, salience.
    const refinementCutoffIso = toIsoInstant(nowMs - this.refinementWindowMs);
    const refinementQueue = consolidated
      .filter(episode => episode.endedAt >= refinementCutoffIso)
      .filter(episode => !refinedEpisodeIds.has(episode.id))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, this.maxRefinementsPerRun);

    const recentEntries = refinementQueue.length > 0
      ? this.sessionReader.getRecentMessages(input.sessionId, this.transcriptMessageLimit)
      : [];
    const refinementAudit: Array<Record<string, unknown>> = [];

    for (const episode of refinementQueue) {
      const excerpt = transcriptExcerptForEpisode(
        episode,
        recentEntries,
        this.maxTranscriptCharsPerEpisode,
      );
      if (!excerpt) {
        // No grounded transcript in reach — refining from metadata alone
        // would invite confabulated meaning. Leave it for a later run.
        result.refinementSkipped += 1;
        log.debug('Skipping episode refinement without transcript coverage', {
          episodeId: episode.id,
          startedAt: episode.startedAt,
        });
        continue;
      }

      const refinement = await this.refineEpisode(episode, excerpt, input);
      if (!refinement) {
        result.refinementSkipped += 1;
        continue;
      }

      await this.store.updateEpisode({
        id: episode.id,
        title: refinement.title,
        landmark: refinement.landmark,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        threadId: episode.threadId,
        channelId: episode.channelId,
        participantContactIds: episode.participantContactIds,
        salience: {
          ...episode.salience,
          score: refinement.salienceScore,
        },
        affect: episode.affect,
        themes: refinement.themes,
        spanRefs: episode.spanRefs,
        artifactRefs: episode.artifactRefs,
        provenanceRefs: episode.provenanceRefs,
      });
      refinementAudit.push({
        episodeId: episode.id,
        previous: {
          title: episode.title,
          landmark: episode.landmark,
          themes: episode.themes,
          salienceScore: episode.salience.score,
        },
        salienceScore: refinement.salienceScore,
        salienceReason: refinement.salienceReason,
      });
      refinedEpisodeIds.add(episode.id);
      result.refinedEpisodes += 1;
    }

    const nowIso = toIsoInstant(nowMs);
    await this.store.upsertProcessingWatermark({
      ...watermarkScope,
      ...(watermark?.id ? { id: watermark.id } : {}),
      processedStartedAt: watermark?.processedStartedAt ?? toIsoInstant(nowMs - this.reviewWindowMs),
      processedEndedAt: nowIso,
      previousWatermarkJson: watermark?.nextWatermarkJson ?? {},
      nextWatermarkJson: {
        refinedEpisodeIds: [...refinedEpisodeIds].slice(-MAX_TRACKED_REFINED_EPISODE_IDS),
        lastRun: {
          at: nowIso,
          ...result,
          refinements: refinementAudit,
        },
      },
      status: 'active',
      reconciliationStatus: 'clean',
      lastProcessedAt: nowIso,
    });

    return result;
  }

  private async refineEpisode(
    episode: Episode,
    excerpt: string,
    input: SleepCycleConsolidationRunInput,
  ): Promise<EpisodeRefinement | null> {
    const requestPrompt = [
      'Episode to refine:',
      JSON.stringify({
        title: episode.title,
        landmark: episode.landmark,
        themes: episode.themes,
        salience: episode.salience,
        affect: episode.affect,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
      }, null, 2),
      '',
      'Transcript excerpt the episode covers:',
      excerpt,
      '',
      'Return the refinement JSON only.',
    ].join('\n');

    try {
      const response = await this.llmProvider.complete(
        {
          systemPrompt: REFINEMENT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: requestPrompt }],
          correlation: {
            requestId: `sleep-consolidation:${input.sessionId}:${episode.id}`,
            channelId: episode.channelId ?? input.sessionId,
            callType: 'memory',
            purpose: 'memory.sleeptime.plan',
            originType: 'memory',
            originStage: 'memory.sleeptime.consolidate',
          },
        },
        'memory',
      );
      return parseRefinement(response.content);
    } catch (error) {
      log.warn('Episode refinement failed; keeping deterministic fields', {
        episodeId: episode.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
