import type {
  Episode,
  EpisodeArcWriteInput,
  EpisodeArtifactRef,
  EpisodeSpanRef,
} from '../../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeCreateInput,
  EpisodeUpdateInput,
} from '../store-port.js';

interface EpisodeCandidateInput extends EpisodeCreateInput {
  id: string;
}

export interface ConsolidationCandidateScore {
  episode: Episode;
  spanOverlapRatio: number;
  themeOverlap: number;
  artifactOverlap: number;
  turnBoundaryOverlap: boolean;
  timeGapMs: number;
}

const MIN_CONSOLIDATION_THEME_OVERLAP = 1;
const MIN_CONSOLIDATION_SPAN_OVERLAP_RATIO = 0.5;
const MAX_CONSOLIDATION_BOUNDARY_GAP_MS = 10 * 60_000;
const MIN_RELATED_THEME_OVERLAP = 1;

function normalizeBoundedUnit(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function themeOverlap(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.reduce((count, theme) => count + (rightSet.has(theme) ? 1 : 0), 0);
}

function spanTimeRange(
  span: EpisodeSpanRef,
  fallbackStartedAt: string,
  fallbackEndedAt: string,
): { startedAt: number; endedAt: number } {
  return {
    startedAt: Date.parse(span.startedAt ?? fallbackStartedAt),
    endedAt: Date.parse(span.endedAt ?? fallbackEndedAt),
  };
}

function intervalOverlapRatio(
  left: { startedAt: number; endedAt: number },
  right: { startedAt: number; endedAt: number },
): number {
  const overlapMs = Math.max(0, Math.min(left.endedAt, right.endedAt) - Math.max(left.startedAt, right.startedAt));
  const leftDurationMs = Math.max(0, left.endedAt - left.startedAt);
  const rightDurationMs = Math.max(0, right.endedAt - right.startedAt);
  const smallerDurationMs = Math.min(leftDurationMs, rightDurationMs);

  if (smallerDurationMs === 0) {
    const leftInsideRight = left.startedAt >= right.startedAt && left.startedAt <= right.endedAt;
    const rightInsideLeft = right.startedAt >= left.startedAt && right.startedAt <= left.endedAt;
    return leftInsideRight || rightInsideLeft ? 1 : 0;
  }

  return normalizeBoundedUnit(overlapMs / smallerDurationMs);
}

function spanOverlapRatio(candidate: EpisodeCandidateInput, episode: Episode): number {
  let best = 0;
  for (const candidateSpan of candidate.spanRefs) {
    const candidateRange = spanTimeRange(candidateSpan, candidate.startedAt, candidate.endedAt);
    for (const episodeSpan of episode.spanRefs) {
      best = Math.max(
        best,
        intervalOverlapRatio(candidateRange, spanTimeRange(episodeSpan, episode.startedAt, episode.endedAt)),
      );
    }
  }
  return best;
}

function timeGapMs(candidate: EpisodeCandidateInput, episode: Episode): number {
  const candidateStart = Date.parse(candidate.startedAt);
  const candidateEnd = Date.parse(candidate.endedAt);
  const episodeStart = Date.parse(episode.startedAt);
  const episodeEnd = Date.parse(episode.endedAt);
  if (candidateStart <= episodeEnd && episodeStart <= candidateEnd) {
    return 0;
  }
  return candidateStart > episodeEnd ? candidateStart - episodeEnd : episodeStart - candidateEnd;
}

function hasTurnBoundaryOverlap(candidate: EpisodeCandidateInput, episode: Episode): boolean {
  const candidateBoundaries = new Set(candidate.spanRefs.flatMap(span => [
    span.startTurnId,
    span.endTurnId,
  ].filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0)));

  return episode.spanRefs.some(span => (
    (span.startTurnId !== undefined && candidateBoundaries.has(span.startTurnId))
    || (span.endTurnId !== undefined && candidateBoundaries.has(span.endTurnId))
  ));
}

function artifactOverlap(left: readonly EpisodeArtifactRef[], right: readonly EpisodeArtifactRef[]): number {
  const rightIds = new Set(right.map(ref => ref.artifactId));
  return left.reduce((count, ref) => count + (rightIds.has(ref.artifactId) ? 1 : 0), 0);
}

function hasMatchingScope(candidate: EpisodeCandidateInput, episode: Episode): boolean {
  const candidateSessionIds = new Set(candidate.spanRefs
    .map(span => span.sessionId)
    .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0));
  const episodeSessionMatches = episode.spanRefs.some(span => (
    span.sessionId !== undefined && candidateSessionIds.has(span.sessionId)
  ));
  const threadMatches = candidate.threadId !== undefined && episode.threadId === candidate.threadId;
  const channelMatches = candidate.channelId !== undefined && (
    episode.channelId === candidate.channelId
    || episode.spanRefs.some(span => span.channelId === candidate.channelId)
  );

  return channelMatches && (threadMatches || episodeSessionMatches);
}

export function scoreConsolidationCandidate(
  candidate: EpisodeCandidateInput,
  episode: Episode,
): ConsolidationCandidateScore | null {
  if (!hasMatchingScope(candidate, episode)) return null;
  const score: ConsolidationCandidateScore = {
    episode,
    spanOverlapRatio: spanOverlapRatio(candidate, episode),
    themeOverlap: themeOverlap(candidate.themes, episode.themes),
    artifactOverlap: artifactOverlap(candidate.artifactRefs, episode.artifactRefs),
    turnBoundaryOverlap: hasTurnBoundaryOverlap(candidate, episode),
    timeGapMs: timeGapMs(candidate, episode),
  };
  const hasSemanticOverlap = score.themeOverlap >= MIN_CONSOLIDATION_THEME_OVERLAP || score.artifactOverlap > 0;
  const hasSpanOverlap = score.spanOverlapRatio >= MIN_CONSOLIDATION_SPAN_OVERLAP_RATIO
    || (
      score.turnBoundaryOverlap
      && score.timeGapMs <= MAX_CONSOLIDATION_BOUNDARY_GAP_MS
    );
  return hasSemanticOverlap && hasSpanOverlap ? score : null;
}

function mergeStringSets(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function mergeByKey<T>(left: readonly T[], right: readonly T[], keyFor: (value: T) => string): T[] {
  const values = new Map<string, T>();
  for (const value of [...left, ...right]) {
    const key = keyFor(value);
    if (!values.has(key)) values.set(key, value);
  }
  return [...values.values()];
}

export function mergeEpisodeWithCandidate(
  canonical: Episode,
  candidate: EpisodeCandidateInput,
): EpisodeUpdateInput {
  return {
    id: canonical.id,
    title: canonical.title,
    landmark: canonical.landmark,
    startedAt: canonical.startedAt <= candidate.startedAt ? canonical.startedAt : candidate.startedAt,
    endedAt: canonical.endedAt >= candidate.endedAt ? canonical.endedAt : candidate.endedAt,
    threadId: canonical.threadId ?? candidate.threadId,
    channelId: canonical.channelId ?? candidate.channelId,
    participantContactIds: mergeStringSets(canonical.participantContactIds, candidate.participantContactIds),
    salience: {
      score: Math.max(canonical.salience.score, candidate.salience.score),
      novelty: Math.max(canonical.salience.novelty ?? 0, candidate.salience.novelty ?? 0),
      emotionalIntensity: Math.max(
        canonical.salience.emotionalIntensity ?? 0,
        candidate.salience.emotionalIntensity ?? 0,
      ),
    },
    affect: {
      ...canonical.affect,
      arousal: Math.max(canonical.affect.arousal ?? 0, candidate.affect.arousal ?? 0),
      labels: mergeStringSets(canonical.affect.labels, candidate.affect.labels),
    },
    themes: mergeStringSets(canonical.themes, candidate.themes),
    spanRefs: mergeByKey(canonical.spanRefs, candidate.spanRefs, ref => ref.spanId),
    artifactRefs: mergeByKey(canonical.artifactRefs, candidate.artifactRefs, ref => ref.artifactId),
    provenanceRefs: mergeByKey(
      canonical.provenanceRefs,
      candidate.provenanceRefs,
      ref => `${ref.kind}:${ref.refId}:${ref.note ?? ''}`,
    ),
  };
}

export function compareConsolidationScores(
  left: ConsolidationCandidateScore,
  right: ConsolidationCandidateScore,
): number {
  if (right.spanOverlapRatio !== left.spanOverlapRatio) return right.spanOverlapRatio - left.spanOverlapRatio;
  if (right.themeOverlap !== left.themeOverlap) return right.themeOverlap - left.themeOverlap;
  if (right.artifactOverlap !== left.artifactOverlap) return right.artifactOverlap - left.artifactOverlap;
  if (left.turnBoundaryOverlap !== right.turnBoundaryOverlap) return left.turnBoundaryOverlap ? -1 : 1;
  if (left.timeGapMs !== right.timeGapMs) return left.timeGapMs - right.timeGapMs;
  return right.episode.startedAt.localeCompare(left.episode.startedAt) || left.episode.id.localeCompare(right.episode.id);
}

function episodeEvidenceText(episode: Episode): string {
  return [
    episode.title,
    episode.landmark,
    ...episode.themes,
    ...episode.affect.labels,
  ].join(' ').toLowerCase();
}

function hasOperatorEvidence(episode: Episode): boolean {
  return episode.provenanceRefs.some(ref => ref.kind === 'operator_note')
    || episode.themes.some(theme => /\boperator(?:[-_ ]defined)?\b/i.test(theme));
}

function classifyArcKind(source: Episode, target: Episode, overlap: number): EpisodeArcWriteInput['arcKind'] {
  const targetText = episodeEvidenceText(target);
  const combinedText = `${episodeEvidenceText(source)} ${targetText}`;
  if (hasOperatorEvidence(source) || hasOperatorEvidence(target)) {
    return 'operator_defined';
  }
  if (/\b(resolved|resolution|fixed|completed|closed|done|finali[sz]ed|shipped|settled|unblocked)\b/.test(targetText)) {
    return 'resolution';
  }
  if (/\b(because|caused|causal|led to|resulted in|triggered|due to|as a result|blocked by|unblocked by)\b/.test(targetText)) {
    return 'causal';
  }
  if (/\b(contrast|different|changed|no longer|instead|opposite|reversed|formerly|moved from|moved to)\b/.test(combinedText)) {
    return 'contrast';
  }
  if (/\b(again|recurr|repeat|same issue|same pattern|returned|routine)\b/.test(targetText)) {
    return 'recurrence';
  }
  if (
    (source.threadId !== undefined && source.threadId === target.threadId)
    || /\b(continue|continuation|follow[- ]?up|update|checkpoint|next step|final pass|back to)\b/.test(targetText)
  ) {
    return 'continuation';
  }
  return overlap > 0 ? 'same_theme' : 'continuation';
}

function arcConfidence(kind: EpisodeArcWriteInput['arcKind'], overlap: number): number {
  const baseByKind: Record<EpisodeArcWriteInput['arcKind'], number> = {
    causal: 0.74,
    continuation: 0.68,
    contrast: 0.7,
    operator_defined: 0.82,
    recurrence: 0.7,
    resolution: 0.76,
    same_theme: 0.55,
  };
  return normalizeBoundedUnit(Math.min(0.95, baseByKind[kind] + Math.min(0.16, overlap * 0.04)));
}

export function buildArcInput(
  source: Episode,
  target: Episode,
  overlap: number,
  stableId: (prefix: string, parts: readonly string[]) => string,
): EpisodeArcWriteInput {
  const sharedThemes = source.themes.filter(theme => target.themes.includes(theme));
  const themes = sharedThemes.length > 0 ? sharedThemes : target.themes.slice(0, 3);
  const arcKind = classifyArcKind(source, target, overlap);
  return {
    id: stableId('episode-arc', [source.id, target.id, themes.join('|')]),
    sourceEpisodeId: source.id,
    targetEpisodeId: target.id,
    arcKind,
    salience: normalizeBoundedUnit(Math.max(0.35, Math.min(source.salience.score, target.salience.score))),
    confidence: arcConfidence(arcKind, overlap),
    themes,
    spanRefs: target.spanRefs,
    artifactRefs: target.artifactRefs,
    provenanceRefs: target.provenanceRefs,
  };
}

export function findRelatedSource(
  target: Episode,
  candidates: readonly Episode[],
): { episode: Episode; overlap: number } | null {
  let best: { episode: Episode; overlap: number; distanceMs: number } | null = null;
  const targetStart = Date.parse(target.startedAt);

  for (const candidate of candidates) {
    if (candidate.id === target.id || candidate.startedAt > target.startedAt) continue;
    const overlap = themeOverlap(candidate.themes, target.themes);
    const sameThread = candidate.threadId !== undefined && candidate.threadId === target.threadId;
    if (overlap < MIN_RELATED_THEME_OVERLAP && !sameThread) continue;

    const distanceMs = Math.max(0, targetStart - Date.parse(candidate.endedAt));
    if (
      !best
      || overlap > best.overlap
      || (overlap === best.overlap && distanceMs < best.distanceMs)
    ) {
      best = { episode: candidate, overlap, distanceMs };
    }
  }

  return best ? { episode: best.episode, overlap: best.overlap } : null;
}

export type { EpisodeCandidateInput };
