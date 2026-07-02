import { createHash } from 'node:crypto';
import type { SessionEntry } from '../../../core/session/types.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type {
  Episode,
  EpisodeAffect,
  EpisodeProvenanceRef,
  EpisodeSalience,
} from '../../../shared/contracts/episodic-memory.js';
import { resolveKnownEpisodeId } from './episode-ids.js';
import type {
  EpisodeCreateInput,
  EpisodeUpdateInput,
  EpisodicStorePort,
} from './store.js';

const log = createComponentLogger('SleepConsolidation');

export interface SleepConsolidationSessionReader {
  getRecentMessages(channelId: string, limit: number): SessionEntry[];
}

/**
 * Typed fail-closed signal: LLM thematic grouping for one candidate cluster
 * produced malformed output or failed outright. The cluster's candidates are
 * left untouched (they stay candidates and are retried next night).
 */
export interface SleepConsolidationFailureEvent {
  sessionId: string;
  scopeKey: string;
  candidateEpisodeIds: string[];
  stage: 'thematic_grouping';
  error: string;
  timestamp: number;
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
  /** Cap on multi-candidate clusters sent through LLM thematic grouping per run. */
  maxConsolidationsPerRun?: number;
  transcriptMessageLimit?: number;
  maxTranscriptCharsPerEpisode?: number;
  /** Typed fail-closed consolidation failures; wired to the event bus by composition. */
  onConsolidationFailure?: (event: SleepConsolidationFailureEvent) => void;
  /** Shared persona preamble service (E6.1); soft persona framing before the consolidation task prompts. */
  personaPreamble?: PersonaPreamblePort | null;
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
  /** Live candidate episodes considered by the candidate-then-consolidate pass. */
  candidateEpisodesReviewed: number;
  /** Same-scope adjacency clusters formed from candidates. */
  candidateClusters: number;
  /** New thematic episodes created from multi-candidate groups. */
  consolidatedEpisodesCreated: number;
  /** Candidates superseded via claim transfer into a consolidated episode. */
  candidatesSuperseded: number;
  /** Candidates confirmed canonical as-is (already one coherent episode). */
  candidatesConfirmed: number;
  /** Clusters that failed closed (malformed/failed LLM grouping); retried next run. */
  consolidationFailures: number;
  /** Multi-candidate clusters deferred by the per-run consolidation budget. */
  consolidationDeferred: number;
}

interface EpisodeRefinement {
  title: string;
  landmark: string;
  themes: string[];
  salienceScore: number;
  salienceReason: string;
}

export interface ThematicGroup {
  candidateIds: string[];
  title: string;
  landmark: string;
  themes: string[];
  salienceScore: number;
}

// Keep deterministic repair broad enough to fold historical canonical overlap
// backlogs; LLM refinement remains separately bounded below.
const DEFAULT_REVIEW_WINDOW_MS = 60 * 24 * 60 * 60_000;
const DEFAULT_REFINEMENT_WINDOW_MS = 36 * 60 * 60_000;
const DEFAULT_ADJACENCY_GAP_MS = 45 * 60_000;
const DEFAULT_MAX_REFINEMENTS_PER_RUN = 8;
const DEFAULT_MAX_CONSOLIDATIONS_PER_RUN = 6;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 200;
const DEFAULT_MAX_TRANSCRIPT_CHARS = 6000;
const REVIEW_EPISODE_LIMIT = 200;
const MAX_TRACKED_REFINED_EPISODE_IDS = 400;
const SLEEP_CONSOLIDATION_PROCESSOR = 'sleep_consolidation';
const CONSOLIDATION_CLAIM_TRANSFER_REASON =
  'sleep-cycle consolidation: overlapping near-real-time candidates folded into one thematic episode';

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

const THEMATIC_GROUPING_SYSTEM_PROMPT = [
  'You are a clinical memory-consolidation stage for a long-lived companion.',
  'Input: a list of CANDIDATE episode records generated near-real-time during one contiguous stretch of conversation.',
  'They are fragments: overlapping, duplicated, or mis-joined machine cuts of the same underlying conversation.',
  'Task: partition the candidates into thematic episodes — "this whole stretch was us discussing X".',
  'Rules:',
  '- Assign EVERY candidate id to EXACTLY ONE group. Never invent, drop, or duplicate ids.',
  '- Candidates about the same topic belong in one group even when their time spans overlap or interleave.',
  '- Candidates about clearly different topics belong in different groups even when adjacent in time; only separate when the evidence is clear.',
  '- When in doubt, prefer one group per contiguous topic stretch.',
  'Return strict JSON only:',
  '{',
  '  "groups": [',
  '    {',
  '      "candidate_ids": ["..."],',
  '      "title": "short thematic phrase for what the stretch was about",',
  '      "landmark": "one or two sentences of narrative meaning — never message counts or statistics",',
  '      "themes": ["3 to 6 semantic topics, lowercase"],',
  '      "salience": 0.0',
  '    }',
  '  ]',
  '}',
  'Salience is significance to the relationship and long-term memory (0 to 1); length must not drive the score.',
  'Ground everything in the provided records and transcript excerpt; never invent events.',
].join('\n');

function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function parseInstant(value: string): number {
  return Date.parse(value);
}

function stableConsolidatedEpisodeId(sourceEpisodeIds: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...sourceEpisodeIds].sort().join('\u001f'))
    .digest('hex')
    .slice(0, 24);
  return `episode:consolidated:${digest}`;
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

function provenanceRefKey(ref: EpisodeProvenanceRef): string {
  return `${ref.kind}:${ref.refId}:${ref.note ?? ''}`;
}

function sameEpisodeScope(left: Episode, right: Episode): boolean {
  const sameChannel = (left.channelId ?? '') === (right.channelId ?? '');
  const sameThread = (left.threadId ?? '') === (right.threadId ?? '');
  if (!sameChannel || !sameThread) return false;
  return [...left.participantContactIds].sort().join(',')
    === [...right.participantContactIds].sort().join(',');
}

function episodeScopeKey(episode: Episode): string {
  return [
    episode.channelId ?? '',
    episode.threadId ?? '',
    [...episode.participantContactIds].sort().join(','),
  ].join('\u0000');
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
  const byScope = new Map<string, Episode[]>();
  for (const episode of ordered) {
    const key = episodeScopeKey(episode);
    const group = byScope.get(key) ?? [];
    group.push(episode);
    byScope.set(key, group);
  }

  const chains: Episode[][] = [];
  for (const scopedEpisodes of byScope.values()) {
    let currentChain: Episode[] = [];
    for (const episode of scopedEpisodes) {
      if (sameSitting(currentChain, episode, adjacencyGapMs)) {
        currentChain.push(episode);
      } else {
        currentChain = [episode];
        chains.push(currentChain);
      }
    }
  }
  return chains.sort((left, right) => (
    left[0]!.startedAt.localeCompare(right[0]!.startedAt)
    || left[0]!.id.localeCompare(right[0]!.id)
  ));
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
    provenanceRefs: mergeUnique(merged.provenanceRefs, episode.provenanceRefs, provenanceRefKey),
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

function mergeSalience(sources: readonly Episode[], score: number): EpisodeSalience {
  const novelty = Math.max(...sources.map(episode => episode.salience.novelty ?? 0));
  const emotionalIntensity = Math.max(
    ...sources.map(episode => episode.salience.emotionalIntensity ?? 0),
  );
  return {
    score,
    ...(novelty > 0 ? { novelty } : {}),
    ...(emotionalIntensity > 0 ? { emotionalIntensity } : {}),
  };
}

function mergeAffect(sources: readonly Episode[]): EpisodeAffect {
  const arousalValues = sources
    .map(episode => episode.affect.arousal)
    .filter((value): value is number => value !== undefined);
  const dominanceValues = sources
    .map(episode => episode.affect.dominance)
    .filter((value): value is number => value !== undefined);
  const valenceSources = [...sources]
    .filter(episode => episode.affect.valence !== undefined)
    .sort((left, right) => right.salience.score - left.salience.score);
  const valence = valenceSources.length > 0 ? valenceSources[0].affect.valence : undefined;
  return {
    ...(valence !== undefined ? { valence } : {}),
    ...(arousalValues.length > 0 ? { arousal: Math.max(...arousalValues) } : {}),
    ...(dominanceValues.length > 0 ? { dominance: Math.max(...dominanceValues) } : {}),
    labels: [...new Set(sources.flatMap(episode => episode.affect.labels))],
  };
}

/**
 * Deterministic consolidated-episode assembly: union of the source
 * candidates' spans, artifacts, and provenance (every covered L0 transcript
 * span keeps an explicit l0_span provenance ref), thematic identity from the
 * validated LLM grouping. The id is stable over the source-id set so a crash
 * between episode creation and claim transfer converges on the next run.
 */
export function buildConsolidatedEpisodeInput(
  sources: readonly Episode[],
  group: Pick<ThematicGroup, 'title' | 'landmark' | 'themes' | 'salienceScore'>,
): EpisodeCreateInput {
  if (sources.length < 2) {
    throw new Error('a consolidated episode requires at least two source candidates');
  }
  const ordered = [...sources].sort((left, right) => (
    left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  ));
  const head = ordered[0];
  const spanRefs = ordered
    .map(episode => episode.spanRefs)
    .reduce((merged, refs) => mergeUnique(merged, refs, ref => ref.spanId));
  let provenanceRefs = ordered
    .map(episode => episode.provenanceRefs)
    .reduce((merged, refs) => mergeUnique(merged, refs, provenanceRefKey));
  // L0 coverage guarantee: every covered transcript span is provenance.
  const coveredSpanIds = new Set(
    provenanceRefs.filter(ref => ref.kind === 'l0_span').map(ref => ref.refId),
  );
  provenanceRefs = [
    ...provenanceRefs,
    ...spanRefs
      .filter(span => !coveredSpanIds.has(span.spanId))
      .map((span): EpisodeProvenanceRef => ({
        kind: 'l0_span',
        refId: span.spanId,
        note: 'sleep-consolidation span coverage',
      })),
  ];

  return {
    id: stableConsolidatedEpisodeId(ordered.map(episode => episode.id)),
    title: group.title,
    landmark: group.landmark,
    startedAt: ordered.reduce((min, episode) => (episode.startedAt < min ? episode.startedAt : min), head.startedAt),
    endedAt: ordered.reduce((max, episode) => (episode.endedAt > max ? episode.endedAt : max), head.endedAt),
    threadId: head.threadId,
    channelId: head.channelId,
    participantContactIds: [...new Set(ordered.flatMap(episode => episode.participantContactIds))].sort(),
    salience: mergeSalience(ordered, group.salienceScore),
    affect: mergeAffect(ordered),
    themes: group.themes,
    spanRefs,
    artifactRefs: ordered
      .map(episode => episode.artifactRefs)
      .reduce((merged, refs) => mergeUnique(merged, refs, ref => ref.artifactId)),
    provenanceRefs,
    lifecycleStatus: 'canonical',
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

function parseGroupText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} chars`);
  }
  return text;
}

function parseGroupThemes(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const themes = [...new Set(
    value
      .map(theme => (typeof theme === 'string' ? theme.trim().toLowerCase() : ''))
      .filter(theme => theme.length > 0 && theme.length <= 64),
  )].slice(0, 8);
  if (themes.length === 0) {
    throw new Error(`${field} must contain at least one non-empty string`);
  }
  return themes;
}

function parseGroupSalience(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number in [0, 1]`);
  }
  return Math.round(value * 100) / 100;
}

/**
 * Schema-bound parse of the thematic grouping. Fails closed unless the
 * groups exactly partition the cluster's candidate ids — no invented,
 * dropped, or duplicated ids.
 */
export function parseThematicGrouping(
  content: string,
  clusterCandidateIds: readonly string[],
): ThematicGroup[] {
  const raw = extractJsonObject(content);
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new Error('grouping must contain a non-empty "groups" array');
  }
  const knownIds = new Set(clusterCandidateIds);
  const assignedIds = new Set<string>();
  const groups = raw.groups.map((entry, index) => {
    const field = `groups[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${field} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (!Array.isArray(record.candidate_ids) || record.candidate_ids.length === 0) {
      throw new Error(`${field}.candidate_ids must be a non-empty array`);
    }
    const candidateIds = record.candidate_ids.map((value) => {
      if (typeof value !== 'string') {
        throw new Error(`${field}.candidate_ids entries must be strings`);
      }
      const resolved = resolveKnownEpisodeId(value.trim(), knownIds);
      if (!resolved) {
        throw new Error(`${field}.candidate_ids references unknown candidate "${value}"`);
      }
      if (assignedIds.has(resolved)) {
        throw new Error(`${field}.candidate_ids assigns candidate "${resolved}" more than once`);
      }
      assignedIds.add(resolved);
      return resolved;
    });
    return {
      candidateIds,
      title: parseGroupText(record.title, `${field}.title`, 160),
      landmark: parseGroupText(record.landmark, `${field}.landmark`, 600),
      themes: parseGroupThemes(record.themes, `${field}.themes`),
      salienceScore: parseGroupSalience(record.salience, `${field}.salience`),
    };
  });
  if (assignedIds.size !== knownIds.size) {
    const missing = clusterCandidateIds.filter(id => !assignedIds.has(id));
    throw new Error(`grouping omitted candidate ids: ${missing.join(', ')}`);
  }
  return groups;
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

function transcriptExcerptForSpan(
  startedAt: string,
  endedAt: string,
  entries: readonly SessionEntry[],
  maxChars: number,
): string {
  const startMs = parseInstant(startedAt);
  const endMs = parseInstant(endedAt);
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

function transcriptExcerptForEpisode(
  episode: Episode,
  entries: readonly SessionEntry[],
  maxChars: number,
): string {
  return transcriptExcerptForSpan(episode.startedAt, episode.endedAt, entries, maxChars);
}

/**
 * Nightly sleep-cycle consolidation (charter 6.21, m58.1). Stages:
 *
 * 1. Candidate consolidation — the candidate-then-consolidate model. Daytime
 *    synthesis output is CANDIDATE episodes; this pass clusters same-scope
 *    overlapping/adjacent candidates, asks a schema-bound LLM grouping which
 *    candidates form one thematic episode, and folds each multi-candidate
 *    group into a new consolidated episode. Message claims move to the
 *    consolidated episode via the transactional claim-transfer API, which
 *    marks the source candidates superseded — never deleted; raw history and
 *    claim history stay intact, and the consolidated episode carries L0
 *    provenance for every covered transcript span. Malformed LLM output
 *    fails closed per cluster: a typed failure event fires and the
 *    candidates stay untouched for the next night. Lone candidates are
 *    confirmed canonical deterministically.
 * 2. Deterministic repair — time-adjacent same-scope CANONICAL episodes with
 *    no active message claims (the pre-claim historical backlog) merge into
 *    one sitting. Claim-holding episodes are products of the claim-era
 *    pipeline (consolidated or confirmed above) and are protected: blind
 *    adjacency merging would destroy deliberate thematic splits.
 * 3. Bounded LLM cleanup of titles, landmarks, themes, and salience. The
 *    companion's own first-person meaning pass is a separate stage (0a5.4)
 *    and intentionally does not happen here.
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
  private readonly maxConsolidationsPerRun: number;
  private readonly transcriptMessageLimit: number;
  private readonly maxTranscriptCharsPerEpisode: number;
  private readonly onConsolidationFailure: ((event: SleepConsolidationFailureEvent) => void) | null;
  private readonly personaPreamble: PersonaPreamblePort | null;

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
    this.maxConsolidationsPerRun = options.maxConsolidationsPerRun ?? DEFAULT_MAX_CONSOLIDATIONS_PER_RUN;
    this.transcriptMessageLimit = options.transcriptMessageLimit ?? DEFAULT_TRANSCRIPT_MESSAGE_LIMIT;
    this.maxTranscriptCharsPerEpisode = options.maxTranscriptCharsPerEpisode ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
    this.onConsolidationFailure = options.onConsolidationFailure ?? null;
    this.personaPreamble = options.personaPreamble ?? null;
  }

  async run(input: SleepCycleConsolidationRunInput): Promise<SleepCycleConsolidationResult> {
    const nowMs = this.now().getTime();
    const reviewFrom = toIsoInstant(nowMs - this.reviewWindowMs);
    const reviewTo = toIsoInstant(nowMs);

    const result: SleepCycleConsolidationResult = {
      reviewedEpisodes: 0,
      mergeChains: 0,
      mergedAwayEpisodes: 0,
      refinedEpisodes: 0,
      refinementSkipped: 0,
      candidateEpisodesReviewed: 0,
      candidateClusters: 0,
      consolidatedEpisodesCreated: 0,
      candidatesSuperseded: 0,
      candidatesConfirmed: 0,
      consolidationFailures: 0,
      consolidationDeferred: 0,
    };

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

    const recentEntries = this.sessionReader.getRecentMessages(
      input.sessionId,
      this.transcriptMessageLimit,
    );

    // Stage 1 — candidate-then-consolidate.
    const consolidatedFromCandidates = await this.consolidateCandidates(
      input,
      { from: reviewFrom, to: reviewTo },
      recentEntries,
      result,
    );

    // Stage 2 — deterministic repair of claim-free canonical episodes.
    const canonicalEpisodes = await this.store.searchByTime({
      from: reviewFrom,
      to: reviewTo,
      lifecycleStatus: 'canonical',
      limit: REVIEW_EPISODE_LIMIT,
    });
    result.reviewedEpisodes = canonicalEpisodes.length;
    if (result.candidateEpisodesReviewed === 0 && canonicalEpisodes.length === 0) {
      return result;
    }
    const repairEligible: Episode[] = [];
    const claimProtected: Episode[] = [];
    for (const episode of canonicalEpisodes) {
      if (await this.hasActiveClaims(episode.id)) {
        claimProtected.push(episode);
      } else {
        repairEligible.push(episode);
      }
    }

    const consolidated: Episode[] = [...claimProtected];
    for (const chain of buildMergeChains(repairEligible, this.adjacencyGapMs)) {
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
    // Newly consolidated thematic episodes are canonical (and claim-holding,
    // so stage 2 already carries them into the pool untouched). Their titles
    // and landmarks came out of the thematic grouping this run, so a second
    // LLM pass would be redundant spend — mark them refined.
    for (const episode of consolidatedFromCandidates) {
      refinedEpisodeIds.add(episode.id);
    }

    // Stage 3 — bounded LLM cleanup of titles, landmarks, themes, salience.
    const refinementCutoffIso = toIsoInstant(nowMs - this.refinementWindowMs);
    const refinementQueue = consolidated
      .filter(episode => episode.endedAt >= refinementCutoffIso)
      .filter(episode => !refinedEpisodeIds.has(episode.id))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, this.maxRefinementsPerRun);

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
      processedStartedAt: watermark?.processedStartedAt ?? reviewFrom,
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

  /**
   * Stage 1: cluster live candidates by scope and adjacency, thematically
   * group each multi-candidate cluster (LLM, schema-bound, fail-closed), and
   * fold each multi-candidate group into a consolidated canonical episode
   * with the claim-transfer/supersede API. Returns the created episodes.
   */
  private async consolidateCandidates(
    input: SleepCycleConsolidationRunInput,
    window: { from: string; to: string },
    recentEntries: readonly SessionEntry[],
    result: SleepCycleConsolidationResult,
  ): Promise<Episode[]> {
    const candidates = await this.store.searchByTime({
      from: window.from,
      to: window.to,
      lifecycleStatus: 'candidate',
      limit: REVIEW_EPISODE_LIMIT,
    });
    result.candidateEpisodesReviewed = candidates.length;
    if (candidates.length === 0) return [];

    const clusters = buildMergeChains(candidates, this.adjacencyGapMs);
    result.candidateClusters = clusters.length;

    const created: Episode[] = [];
    let llmBudget = this.maxConsolidationsPerRun;
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        await this.store.confirmEpisodeCanonical(cluster[0].id);
        result.candidatesConfirmed += 1;
        continue;
      }
      if (llmBudget === 0) {
        result.consolidationDeferred += 1;
        continue;
      }
      llmBudget -= 1;

      let groups: ThematicGroup[];
      try {
        groups = await this.groupClusterThematically(cluster, recentEntries, input);
      } catch (error) {
        // Fail closed: no consolidation applied, candidates untouched, typed
        // failure event for the Garden subsystem-health view.
        result.consolidationFailures += 1;
        const failure: SleepConsolidationFailureEvent = {
          sessionId: input.sessionId,
          scopeKey: episodeScopeKey(cluster[0]),
          candidateEpisodeIds: cluster.map(episode => episode.id),
          stage: 'thematic_grouping',
          error: error instanceof Error ? error.message : String(error),
          timestamp: this.now().getTime(),
        };
        log.warn('Sleep-cycle thematic grouping failed closed; candidates left untouched', {
          sessionId: failure.sessionId,
          candidateEpisodeIds: failure.candidateEpisodeIds,
          error: failure.error,
        });
        this.onConsolidationFailure?.(failure);
        continue;
      }

      const clusterById = new Map(cluster.map(episode => [episode.id, episode]));
      for (const group of groups) {
        if (group.candidateIds.length === 1) {
          await this.store.confirmEpisodeCanonical(group.candidateIds[0]);
          result.candidatesConfirmed += 1;
          continue;
        }
        const sources = group.candidateIds.map(id => clusterById.get(id)!);
        created.push(await this.applyThematicGroup(sources, group, input));
        result.consolidatedEpisodesCreated += 1;
        result.candidatesSuperseded += sources.length;
      }
    }
    return created;
  }

  private async applyThematicGroup(
    sources: readonly Episode[],
    group: ThematicGroup,
    input: SleepCycleConsolidationRunInput,
  ): Promise<Episode> {
    const episodeInput = buildConsolidatedEpisodeInput(sources, group);
    // Stable id: a crash between creation and claim transfer converges here
    // instead of leaving an orphan duplicate.
    const consolidated = (episodeInput.id ? await this.store.getEpisode(episodeInput.id) : undefined)
      ?? await this.store.createEpisode(episodeInput);

    const transfer = await this.store.transferEpisodeMessageClaims({
      sourceEpisodeIds: sources.map(episode => episode.id),
      targetEpisodeId: consolidated.id,
      reason: CONSOLIDATION_CLAIM_TRANSFER_REASON,
    });

    for (const source of sources) {
      await this.store.writeEpisodeLineage({
        sourceEpisodeId: source.id,
        targetEpisodeId: consolidated.id,
        relation: 'canonicalizes',
        confidence: 0.9,
        reason: CONSOLIDATION_CLAIM_TRANSFER_REASON,
        sourceRef: input.sessionId,
        provenanceRefs: source.provenanceRefs,
        lineageJson: {
          processor: SLEEP_CONSOLIDATION_PROCESSOR,
          stage: 'candidate_consolidation',
          candidateTitle: source.title,
          candidateSpan: { startedAt: source.startedAt, endedAt: source.endedAt },
          consolidatedTitle: group.title,
        },
      });
      await this.store.writeEpisodeCandidateDecision({
        candidateEpisodeId: source.id,
        canonicalEpisodeId: consolidated.id,
        supersededByEpisodeId: consolidated.id,
        status: 'superseded',
        ...(source.channelId ? { channelId: source.channelId } : {}),
        ...(source.threadId ? { threadId: source.threadId } : {}),
        sessionId: input.sessionId,
        startedAt: source.startedAt,
        endedAt: source.endedAt,
        confidence: 0.9,
        reason: CONSOLIDATION_CLAIM_TRANSFER_REASON,
        candidateJson: {
          processor: SLEEP_CONSOLIDATION_PROCESSOR,
          candidateTitle: source.title,
          candidateThemes: source.themes,
        },
        artifactRefs: source.artifactRefs,
        provenanceRefs: source.provenanceRefs,
      });
    }

    log.info('Consolidated candidate episodes into thematic episode', {
      sessionId: input.sessionId,
      consolidatedEpisodeId: consolidated.id,
      sourceEpisodeIds: transfer.supersededEpisodeIds,
      transferredClaims: transfer.transferredClaims.length,
      title: group.title,
    });
    return consolidated;
  }

  private async groupClusterThematically(
    cluster: readonly Episode[],
    recentEntries: readonly SessionEntry[],
    input: SleepCycleConsolidationRunInput,
  ): Promise<ThematicGroup[]> {
    const clusterStart = cluster.reduce(
      (min, episode) => (episode.startedAt < min ? episode.startedAt : min),
      cluster[0].startedAt,
    );
    const clusterEnd = cluster.reduce(
      (max, episode) => (episode.endedAt > max ? episode.endedAt : max),
      cluster[0].endedAt,
    );
    const excerpt = transcriptExcerptForSpan(
      clusterStart,
      clusterEnd,
      recentEntries,
      this.maxTranscriptCharsPerEpisode,
    );

    const requestPrompt = [
      'Candidate episodes (one contiguous stretch, same scope):',
      JSON.stringify(cluster.map(episode => ({
        id: episode.id,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        title: episode.title,
        landmark: episode.landmark,
        themes: episode.themes,
        salience: episode.salience.score,
      })), null, 2),
      '',
      excerpt
        ? `Transcript excerpt the stretch covers:\n${excerpt}`
        : 'No transcript excerpt is in reach; ground the grouping in the candidate records only.',
      '',
      'Return the grouping JSON only.',
    ].join('\n');

    // E6.1: soft persona framing precedes the strict task instructions and JSON schema.
    const groupingSystemPrompt = this.personaPreamble
      ? this.personaPreamble.prepend('sleep_thematic_grouping', THEMATIC_GROUPING_SYSTEM_PROMPT)
      : THEMATIC_GROUPING_SYSTEM_PROMPT;
    const response = await this.llmProvider.complete(
      {
        systemPrompt: groupingSystemPrompt,
        messages: [{ role: 'user', content: requestPrompt }],
        correlation: {
          requestId: `sleep-consolidation:group:${input.sessionId}:${cluster[0].id}`,
          channelId: cluster[0].channelId ?? input.sessionId,
          callType: 'memory',
          purpose: 'memory.sleeptime.plan',
          originType: 'memory',
          originStage: 'memory.sleeptime.consolidate',
        },
      },
      'memory',
    );
    return parseThematicGrouping(response.content, cluster.map(episode => episode.id));
  }

  private async hasActiveClaims(episodeId: string): Promise<boolean> {
    const claims = await this.store.listEpisodeMessageClaims({
      episodeId,
      status: 'active',
      limit: 1,
    });
    return claims.length > 0;
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
      const refinementSystemPrompt = this.personaPreamble
        ? this.personaPreamble.prepend('sleep_refinement', REFINEMENT_SYSTEM_PROMPT)
        : REFINEMENT_SYSTEM_PROMPT;
      const response = await this.llmProvider.complete(
        {
          systemPrompt: refinementSystemPrompt,
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
