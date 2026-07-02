import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  EPISODE_ARC_KINDS,
  type Episode,
  type EpisodeArcKind,
} from '../../../shared/contracts/episodic-memory.js';
import { resolveKnownEpisodeId } from './episode-ids.js';
import type { EpisodicStorePort } from './store.js';

const log = createComponentLogger('ArcFormation');

export interface ArcFormationOptions {
  now?: () => Date;
  /** Minimum time between passes; arcs form on a slower cadence than nightly consolidation. */
  passIntervalMs?: number;
  /** How far back the pass looks for related episodes. */
  reviewWindowMs?: number;
  /** Cap on arcs written per pass. */
  maxArcsPerRun?: number;
  /** Cap on episodes included in the LLM judgment prompt. */
  maxEpisodesPerRun?: number;
  /** Confidence floor below which proposed arcs are rejected (0..1). */
  minConfidence?: number;
}

export interface ArcFormationRunInput {
  sessionId: string;
  sourceMessageId?: string;
}

export interface ArcFormationRunResult {
  ran: boolean;
  skippedReason?: 'cadence' | 'not_enough_episodes' | 'no_candidate_groups';
  reviewedEpisodes: number;
  proposedArcs: number;
  writtenArcs: number;
  rejectedArcs: number;
}

interface ProposedArc {
  episodeIds: string[];
  kind: EpisodeArcKind;
  label: string;
  confidence: number;
  reason: string;
}

const DEFAULT_PASS_INTERVAL_MS = 6 * 24 * 60 * 60_000;
const DEFAULT_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_ARCS_PER_RUN = 12;
const DEFAULT_MAX_EPISODES_PER_RUN = 60;
const MIN_EPISODES_FOR_PASS = 4;
const MIN_ARC_CONFIDENCE = 0.5;
const ARC_FORMATION_PROCESSOR = 'arc_formation';
const ARC_KIND_SET = new Set<string>(EPISODE_ARC_KINDS);

const ARC_JUDGMENT_SYSTEM_PROMPT = [
  'You weave episodic memories of a long-lived companion into narrative arcs.',
  'You receive a chronological list of episodes (id, dates, title, landmark, themes).',
  'Identify arcs: sequences of two or more episodes that belong to one ongoing story across days or weeks — a project being worked on, a recurring conversation theme, a developing relationship thread, a problem and its later resolution.',
  'Return strict JSON only:',
  '{',
  '  "arcs": [',
  '    {',
  '      "episode_ids": ["chronological ids belonging to the arc"],',
  '      "kind": "continuation|causal|contrast|resolution|recurrence|same_theme",',
  '      "label": "short name for the story (e.g. \'postgres memory cutover\', \'planning the trip\')",',
  '      "confidence": 0.0,',
  '      "reason": "one sentence"',
  '    }',
  '  ]',
  '}',
  'Only link episodes that genuinely share a story; an empty arcs array is a valid answer.',
  'Do not invent episode ids.',
].join('\n');

function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function summarizeEpisodeForJudgment(episode: Episode): Record<string, unknown> {
  return {
    id: episode.id,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    title: episode.title,
    landmark: episode.landmark,
    themes: episode.themes,
  };
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

export interface ProposedArcParseResult {
  proposals: ProposedArc[];
  /** Proposals dropped during validation, with the reason each was dropped. */
  rejectedProposals: string[];
}

/**
 * One invalid proposal must not discard the rest of the batch: each entry
 * validates independently, and everything dropped is reported by reason.
 */
export function parseProposedArcs(content: string, knownEpisodeIds: ReadonlySet<string>): ProposedArcParseResult {
  const raw = extractJsonObject(content);
  if (!Array.isArray(raw.arcs)) {
    throw new Error('arc judgment response must contain an arcs array');
  }
  const proposals: ProposedArc[] = [];
  const rejectedProposals: string[] = [];
  for (const entry of raw.arcs) {
    try {
      proposals.push(parseArcProposal(entry, knownEpisodeIds));
    } catch (error) {
      rejectedProposals.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { proposals, rejectedProposals };
}

function parseArcProposal(entry: unknown, knownEpisodeIds: ReadonlySet<string>): ProposedArc {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('arc proposal must be an object');
  }
  const record = entry as Record<string, unknown>;
  const rawEpisodeIds = Array.isArray(record.episode_ids)
    ? record.episode_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (rawEpisodeIds.length < 2) {
    throw new Error('arc proposal must list at least two episode ids');
  }
  const episodeIds: string[] = [];
  for (const id of rawEpisodeIds) {
    const resolvedId = resolveKnownEpisodeId(id, knownEpisodeIds);
    if (!resolvedId) {
      throw new Error(`arc proposal references unknown episode id "${id}"`);
    }
    episodeIds.push(resolvedId);
  }
  if (new Set(episodeIds).size !== episodeIds.length) {
    throw new Error('arc proposal episode ids must be unique');
  }
  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  if (!ARC_KIND_SET.has(kind) || kind === 'operator_defined') {
    throw new Error(`arc proposal kind "${kind}" is not a valid machine arc kind`);
  }
  const label = typeof record.label === 'string' ? record.label.trim().toLowerCase() : '';
  if (!label || label.length > 80) {
    throw new Error('arc proposal label must be a non-empty string up to 80 chars');
  }
  const confidence = record.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('arc proposal confidence must be a finite number in [0, 1]');
  }
  return {
    episodeIds,
    kind: kind as EpisodeArcKind,
    label,
    confidence: Math.round(confidence * 100) / 100,
    reason: typeof record.reason === 'string' ? record.reason.trim() : '',
  };
}

/**
 * Weekly rest-window pass (charter 6.21): links related episodes across days
 * and weeks into graph arcs instead of collapsing long-running themes into
 * mega-episodes. Deterministic prefilter (theme/thread overlap across
 * different days) selects candidates; a background-model judgment over
 * episode summaries decides which sequences are genuinely one story.
 */
export class EpisodeArcWeaver {
  private readonly store: EpisodicStorePort;
  private readonly llmProvider: Pick<LLMProviderPort, 'complete'>;
  private readonly now: () => Date;
  private readonly passIntervalMs: number;
  private readonly reviewWindowMs: number;
  private readonly maxArcsPerRun: number;
  private readonly maxEpisodesPerRun: number;
  private readonly minConfidence: number;

  constructor(
    store: EpisodicStorePort,
    llmProvider: Pick<LLMProviderPort, 'complete'>,
    options: ArcFormationOptions = {},
  ) {
    this.store = store;
    this.llmProvider = llmProvider;
    this.now = options.now ?? (() => new Date());
    this.passIntervalMs = options.passIntervalMs ?? DEFAULT_PASS_INTERVAL_MS;
    this.reviewWindowMs = options.reviewWindowMs ?? DEFAULT_REVIEW_WINDOW_MS;
    this.maxArcsPerRun = options.maxArcsPerRun ?? DEFAULT_MAX_ARCS_PER_RUN;
    this.maxEpisodesPerRun = options.maxEpisodesPerRun ?? DEFAULT_MAX_EPISODES_PER_RUN;
    const minConfidence = options.minConfidence ?? MIN_ARC_CONFIDENCE;
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new Error('ArcFormationOptions.minConfidence must be a number between 0 and 1');
    }
    this.minConfidence = minConfidence;
  }

  async run(input: ArcFormationRunInput): Promise<ArcFormationRunResult> {
    const nowMs = this.now().getTime();
    const watermarkScope = {
      processor: ARC_FORMATION_PROCESSOR,
      sourceRef: input.sessionId,
    };
    const watermark = await this.store.getProcessingWatermark(watermarkScope);
    const lastRunAtMs = watermark?.lastProcessedAt ? Date.parse(watermark.lastProcessedAt) : Number.NaN;
    if (Number.isFinite(lastRunAtMs) && nowMs - lastRunAtMs < this.passIntervalMs) {
      return {
        ran: false,
        skippedReason: 'cadence',
        reviewedEpisodes: 0,
        proposedArcs: 0,
        writtenArcs: 0,
        rejectedArcs: 0,
      };
    }

    const episodes = (await this.store.searchByTime({
      from: toIsoInstant(nowMs - this.reviewWindowMs),
      to: toIsoInstant(nowMs),
      limit: this.maxEpisodesPerRun,
    })).sort((left, right) => left.startedAt.localeCompare(right.startedAt));

    const result: ArcFormationRunResult = {
      ran: true,
      reviewedEpisodes: episodes.length,
      proposedArcs: 0,
      writtenArcs: 0,
      rejectedArcs: 0,
    };
    if (episodes.length < MIN_EPISODES_FOR_PASS) {
      result.ran = false;
      result.skippedReason = 'not_enough_episodes';
      return result;
    }

    const { proposals, rejectedProposals } = await this.judgeArcs(episodes, input);
    result.proposedArcs = proposals.length + rejectedProposals.length;
    result.rejectedArcs = rejectedProposals.length;
    if (rejectedProposals.length > 0) {
      log.warn('Arc proposals dropped during validation', {
        sessionId: input.sessionId,
        dropped: rejectedProposals,
      });
    }

    const episodesById = new Map(episodes.map(episode => [episode.id, episode]));
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      if (result.writtenArcs >= this.maxArcsPerRun) {
        log.info('Arc cap reached for this pass; remaining proposals deferred', {
          maxArcsPerRun: this.maxArcsPerRun,
          deferred: proposals.length - index,
        });
        break;
      }
      if (proposal.confidence < this.minConfidence) {
        result.rejectedArcs += 1;
        continue;
      }
      const ordered = [...proposal.episodeIds].sort((left, right) => {
        const leftEpisode = episodesById.get(left);
        const rightEpisode = episodesById.get(right);
        return (leftEpisode?.startedAt ?? '').localeCompare(rightEpisode?.startedAt ?? '');
      });
      for (let index = 0; index + 1 < ordered.length; index += 1) {
        const source = episodesById.get(ordered[index]);
        const target = episodesById.get(ordered[index + 1]);
        if (!source || !target) continue;
        if (await this.arcAlreadyExists(source.id, target.id)) continue;
        if (result.writtenArcs >= this.maxArcsPerRun) break;
        await this.store.writeEpisodeArc({
          sourceEpisodeId: source.id,
          targetEpisodeId: target.id,
          arcKind: proposal.kind,
          salience: Math.max(source.salience.score, target.salience.score),
          confidence: proposal.confidence,
          themes: [proposal.label],
          spanRefs: [],
          artifactRefs: [],
          provenanceRefs: [
            ...source.provenanceRefs,
            ...target.provenanceRefs,
          ].slice(0, 16),
        });
        result.writtenArcs += 1;
      }
    }

    const nowIso = toIsoInstant(nowMs);
    await this.store.upsertProcessingWatermark({
      ...watermarkScope,
      ...(watermark?.id ? { id: watermark.id } : {}),
      processedStartedAt: toIsoInstant(nowMs - this.reviewWindowMs),
      processedEndedAt: nowIso,
      previousWatermarkJson: watermark?.nextWatermarkJson ?? {},
      nextWatermarkJson: {
        lastRun: { at: nowIso, ...result },
      },
      status: 'active',
      reconciliationStatus: 'clean',
      lastProcessedAt: nowIso,
    });

    return result;
  }

  private async arcAlreadyExists(sourceEpisodeId: string, targetEpisodeId: string): Promise<boolean> {
    const arcs = await this.store.listEpisodeArcsForEpisode(sourceEpisodeId, { direction: 'both' });
    return arcs.some(arc => (
      (arc.sourceEpisodeId === sourceEpisodeId && arc.targetEpisodeId === targetEpisodeId)
      || (arc.sourceEpisodeId === targetEpisodeId && arc.targetEpisodeId === sourceEpisodeId)
    ));
  }

  private async judgeArcs(episodes: readonly Episode[], input: ArcFormationRunInput): Promise<ProposedArcParseResult> {
    const requestPrompt = [
      'Episodes in chronological order:',
      JSON.stringify(episodes.map(summarizeEpisodeForJudgment), null, 2),
      '',
      'Return the arcs JSON only.',
    ].join('\n');

    try {
      const response = await this.llmProvider.complete(
        {
          systemPrompt: ARC_JUDGMENT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: requestPrompt }],
          correlation: {
            requestId: `arc-formation:${input.sessionId}:${String(this.now().getTime())}`,
            channelId: input.sessionId,
            callType: 'memory',
            purpose: 'memory.sleeptime.plan',
            originType: 'memory',
            originStage: 'memory.sleeptime.arcs',
          },
        },
        'memory',
      );
      return parseProposedArcs(response.content, new Set(episodes.map(episode => episode.id)));
    } catch (error) {
      log.warn('Arc judgment failed; no arcs written this pass', {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { proposals: [], rejectedProposals: [] };
    }
  }
}
